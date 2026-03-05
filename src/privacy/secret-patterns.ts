export type SecretCategory =
  | "api_key"
  | "token"
  | "private_key"
  | "connection_string"
  | "entropy_marker";

export type SecretSeverity = "high" | "medium";
export type FalsePositiveLikelihood = "low" | "medium" | "high";

export interface SecretPatternEntry {
  id: string;
  category: Exclude<SecretCategory, "entropy_marker">;
  severity: SecretSeverity;
  falsePositiveLikelihood: FalsePositiveLikelihood;
  regex: RegExp;
  captureGroup?: number;
}

export interface SecretMatch {
  id: string;
  category: SecretCategory;
  severity: SecretSeverity;
  falsePositiveLikelihood: FalsePositiveLikelihood;
  start: number;
  end: number;
  value: string;
  markerOnly: boolean;
}

export interface SecretRange {
  start: number;
  end: number;
}

export interface EntropyDetectorOptions {
  minLength?: number;
  minEntropy?: number;
  candidatePattern?: RegExp;
}

export interface FindSecretPatternMatchesOptions {
  patterns?: readonly SecretPatternEntry[];
  extraPatterns?: readonly SecretPatternEntry[];
}

export interface DetectSecretsOptions extends FindSecretPatternMatchesOptions {
  includeEntropyMarkers?: boolean;
  entropy?: EntropyDetectorOptions;
}

const DEFAULT_ENTROPY_MIN_LENGTH = 28;
const DEFAULT_ENTROPY_THRESHOLD = 4.25;
const DEFAULT_ENTROPY_CANDIDATE_PATTERN = /\b(?:[A-Fa-f0-9]{28,}|[A-Za-z0-9+/_-]{28,}={0,2})\b/g;
export const ENTROPY_MARKER_ID = "entropy.high-shannon";

export const DEFAULT_SECRET_PATTERNS: readonly SecretPatternEntry[] = [
  {
    id: "aws-access-key-id",
    category: "api_key",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    category: "api_key",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\bgh(?:p|o|s|r)_[A-Za-z0-9]{20,255}\b/g,
  },
  {
    id: "stripe-secret-key",
    category: "api_key",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "google-api-key",
    category: "api_key",
    severity: "high",
    falsePositiveLikelihood: "medium",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  {
    id: "slack-token",
    category: "api_key",
    severity: "high",
    falsePositiveLikelihood: "medium",
    regex: /\bxox(?:b|p|s)-[0-9A-Za-z-]{10,200}\b/g,
  },
  {
    id: "jwt-token",
    category: "token",
    severity: "high",
    falsePositiveLikelihood: "medium",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "bearer-token",
    category: "token",
    severity: "high",
    falsePositiveLikelihood: "medium",
    regex: /\bBearer\s+([A-Za-z0-9._~+/-]{20,})\b/gi,
    captureGroup: 1,
  },
  {
    id: "oauth-token-assignment",
    category: "token",
    severity: "medium",
    falsePositiveLikelihood: "medium",
    regex: /\b(?:oauth|access|refresh)_token\b\s*[:=]\s*["']?([A-Za-z0-9._-]{16,})["']?/gi,
    captureGroup: 1,
  },
  {
    id: "private-key-block",
    category: "private_key",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /-----BEGIN(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----[\s\S]{20,}?-----END(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----/g,
  },
  {
    id: "postgres-uri-with-credentials",
    category: "connection_string",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\b(?:postgres|postgresql):\/\/[^/\s:@]+:[^@\s]+@[^/\s]+[^\s]*/gi,
  },
  {
    id: "mysql-uri-with-credentials",
    category: "connection_string",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\bmysql:\/\/[^/\s:@]+:[^@\s]+@[^/\s]+[^\s]*/gi,
  },
  {
    id: "mongodb-uri-with-credentials",
    category: "connection_string",
    severity: "high",
    falsePositiveLikelihood: "low",
    regex: /\bmongodb(?:\+srv)?:\/\/[^/\s:@]+:[^@\s]+@[^/\s]+[^\s]*/gi,
  },
  {
    id: "redis-uri-with-credentials",
    category: "connection_string",
    severity: "high",
    falsePositiveLikelihood: "medium",
    regex: /\bredis:\/\/[^/\s:@]+:[^@\s]+@[^/\s]+[^\s]*/gi,
  },
];

function toGlobalRegex(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function overlapsRange(range: SecretRange, existing: readonly SecretRange[]): boolean {
  for (const candidate of existing) {
    if (range.start < candidate.end && candidate.start < range.end) {
      return true;
    }
  }
  return false;
}

function sortMatchesDeterministically(matches: SecretMatch[]): SecretMatch[] {
  return matches
    .slice()
    .sort((left, right) => {
      if (left.start !== right.start) {
        return left.start - right.start;
      }
      if (left.end !== right.end) {
        return left.end - right.end;
      }
      return left.id.localeCompare(right.id);
    });
}

function resolvePatternSet(
  options?: FindSecretPatternMatchesOptions,
): readonly SecretPatternEntry[] {
  const explicit = options?.patterns ?? DEFAULT_SECRET_PATTERNS;
  const extra = options?.extraPatterns ?? [];
  if (extra.length === 0) {
    return explicit;
  }
  return [...explicit, ...extra];
}

export function calculateShannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function isConservativeEntropyCandidate(value: string, minLength: number): boolean {
  if (value.length < minLength) {
    return false;
  }

  let hasLetter = false;
  let hasDigit = false;
  for (const char of value) {
    if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z")) {
      hasLetter = true;
      continue;
    }
    if (char >= "0" && char <= "9") {
      hasDigit = true;
      continue;
    }
    if (char === "+" || char === "/" || char === "_" || char === "-" || char === "=") {
      continue;
    }
    return false;
  }

  return hasLetter && hasDigit;
}

export function findSecretPatternMatches(
  text: string,
  options?: FindSecretPatternMatchesOptions,
): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const pattern of resolvePatternSet(options)) {
    const regex = toGlobalRegex(pattern.regex);
    let result: RegExpExecArray | null;
    while ((result = regex.exec(text)) !== null) {
      const fullMatch = result[0];
      if (fullMatch.length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      const captureGroup = pattern.captureGroup ?? 0;
      let value = fullMatch;
      let start = result.index;
      if (captureGroup > 0) {
        const captured = result[captureGroup];
        if (captured && captured.length > 0) {
          const offset = fullMatch.indexOf(captured);
          if (offset >= 0) {
            start += offset;
            value = captured;
          }
        }
      }
      const end = start + value.length;

      matches.push({
        id: pattern.id,
        category: pattern.category,
        severity: pattern.severity,
        falsePositiveLikelihood: pattern.falsePositiveLikelihood,
        start,
        end,
        value,
        markerOnly: false,
      });
    }
  }

  return sortMatchesDeterministically(matches);
}

export function findEntropyMarkers(
  text: string,
  options?: EntropyDetectorOptions,
  blockedRanges: readonly SecretRange[] = [],
): SecretMatch[] {
  const minLength = Math.max(1, Math.floor(options?.minLength ?? DEFAULT_ENTROPY_MIN_LENGTH));
  const minEntropy = options?.minEntropy ?? DEFAULT_ENTROPY_THRESHOLD;
  const candidateRegex = toGlobalRegex(
    options?.candidatePattern ?? DEFAULT_ENTROPY_CANDIDATE_PATTERN,
  );

  const matches: SecretMatch[] = [];
  let result: RegExpExecArray | null;
  while ((result = candidateRegex.exec(text)) !== null) {
    const value = result[0];
    const start = result.index;
    const end = start + value.length;
    if (value.length === 0) {
      candidateRegex.lastIndex += 1;
      continue;
    }

    const range = { start, end };
    if (overlapsRange(range, blockedRanges)) {
      continue;
    }
    if (!isConservativeEntropyCandidate(value, minLength)) {
      continue;
    }
    if (calculateShannonEntropy(value) < minEntropy) {
      continue;
    }

    matches.push({
      id: ENTROPY_MARKER_ID,
      category: "entropy_marker",
      severity: "medium",
      falsePositiveLikelihood: "high",
      start,
      end,
      value,
      markerOnly: true,
    });
  }

  return sortMatchesDeterministically(matches);
}

export function detectSecrets(text: string, options?: DetectSecretsOptions): SecretMatch[] {
  const patternMatches = findSecretPatternMatches(text, options);
  if (!options?.includeEntropyMarkers) {
    return patternMatches;
  }

  const blockedRanges: SecretRange[] = patternMatches.map((match) => ({
    start: match.start,
    end: match.end,
  }));
  const entropyMarkers = findEntropyMarkers(text, options.entropy, blockedRanges);
  return sortMatchesDeterministically([...patternMatches, ...entropyMarkers]);
}
