import {
  detectSecrets,
  type DetectSecretsOptions,
  type SecretPatternEntry,
  type SecretCategory,
  type SecretMatch,
  type SecretRange,
} from "./secret-patterns";

const EXISTING_REDACTION_MARKER = /‹REDACTED:[^›\n]+›/g;

export interface RedactionOptions extends DetectSecretsOptions {
  enabled?: boolean;
  markerFormatter?: (reason: string, match: SecretMatch) => string;
}

export interface AppliedRedaction extends SecretRange {
  category: SecretCategory;
  reason: string;
  replacement: string;
  markerOnly: boolean;
}

export interface RedactionResult {
  text: string;
  redactionEnabled: boolean;
  redactionCount: number;
  categoryCounts: Record<string, number>;
  reasonCounts: Record<string, number>;
  redactions: AppliedRedaction[];
}

export interface CompileExtraRedactPatternsResult {
  patterns: SecretPatternEntry[];
  invalidPatterns: string[];
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function overlapsRange(range: SecretRange, existing: readonly SecretRange[]): boolean {
  for (const candidate of existing) {
    if (range.start < candidate.end && candidate.start < range.end) {
      return true;
    }
  }
  return false;
}

function collectExistingMarkerRanges(text: string): SecretRange[] {
  const ranges: SecretRange[] = [];
  const regex = new RegExp(EXISTING_REDACTION_MARKER.source, EXISTING_REDACTION_MARKER.flags);
  let result: RegExpExecArray | null;
  while ((result = regex.exec(text)) !== null) {
    const value = result[0];
    if (value.length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    ranges.push({
      start: result.index,
      end: result.index + value.length,
    });
  }
  return ranges;
}

function sortByReplacementOrder(matches: SecretMatch[]): SecretMatch[] {
  return matches.slice().sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    const leftLength = left.end - left.start;
    const rightLength = right.end - right.start;
    if (leftLength !== rightLength) {
      return rightLength - leftLength;
    }
    return left.id.localeCompare(right.id);
  });
}

function pickNonOverlapping(matches: SecretMatch[]): SecretMatch[] {
  const ordered = sortByReplacementOrder(matches);
  const selected: SecretMatch[] = [];
  let cursor = -1;
  for (const match of ordered) {
    if (match.start < cursor) {
      continue;
    }
    selected.push(match);
    cursor = match.end;
  }
  return selected;
}

function normalizeReason(match: SecretMatch): string {
  if (match.markerOnly) {
    return "entropy_marker";
  }

  const normalized = match.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || match.category;
}

function defaultMarkerFormatter(reason: string): string {
  return `‹REDACTED:${reason}›`;
}

function sanitizeMarker(marker: string): string {
  return marker.replace(/\r?\n/g, " ");
}

function preserveLineStructure(replacement: string, originalValue: string): string {
  const newlineCount = (originalValue.match(/\r?\n/g) ?? []).length;
  if (newlineCount === 0) {
    return replacement;
  }
  return `${replacement}${"\n".repeat(newlineCount)}`;
}

function parseRegexPattern(value: string): RegExp {
  const trimmed = value.trim();
  const literalMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (literalMatch) {
    return new RegExp(literalMatch[1]!, literalMatch[2] ?? "");
  }
  return new RegExp(trimmed);
}

export function compileExtraRedactPatterns(
  patterns: readonly string[],
): CompileExtraRedactPatternsResult {
  const compiled: SecretPatternEntry[] = [];
  const invalidPatterns: string[] = [];

  for (let index = 0; index < patterns.length; index += 1) {
    const source = patterns[index]?.trim() ?? "";
    if (source.length === 0) {
      invalidPatterns.push(patterns[index] ?? "");
      continue;
    }

    try {
      compiled.push({
        id: `custom-pattern-${index + 1}`,
        category: "token",
        severity: "medium",
        falsePositiveLikelihood: "high",
        regex: parseRegexPattern(source),
      });
    } catch {
      invalidPatterns.push(source);
    }
  }

  return {
    patterns: compiled,
    invalidPatterns,
  };
}

function emptyResult(text: string, redactionEnabled: boolean): RedactionResult {
  return {
    text,
    redactionEnabled,
    redactionCount: 0,
    categoryCounts: {},
    reasonCounts: {},
    redactions: [],
  };
}

export function redactText(text: string, options?: RedactionOptions): RedactionResult {
  const enabled = options?.enabled ?? true;
  if (!enabled) {
    return emptyResult(text, false);
  }

  const existingMarkerRanges = collectExistingMarkerRanges(text);
  const detectedMatches = detectSecrets(text, options).filter((match) => {
    const range = { start: match.start, end: match.end };
    return !overlapsRange(range, existingMarkerRanges);
  });

  if (detectedMatches.length === 0) {
    return emptyResult(text, true);
  }

  const matches = pickNonOverlapping(detectedMatches);
  const markerFormatter = options?.markerFormatter ?? defaultMarkerFormatter;
  const categoryCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const redactions: AppliedRedaction[] = [];

  let cursor = 0;
  let output = "";
  for (const match of matches) {
    const reason = normalizeReason(match);
    const replacement = preserveLineStructure(
      sanitizeMarker(markerFormatter(reason, match)),
      text.slice(match.start, match.end),
    );
    output += text.slice(cursor, match.start);
    output += replacement;
    cursor = match.end;

    incrementCounter(categoryCounts, match.category);
    incrementCounter(reasonCounts, reason);
    redactions.push({
      start: match.start,
      end: match.end,
      category: match.category,
      reason,
      replacement,
      markerOnly: match.markerOnly,
    });
  }

  output += text.slice(cursor);

  return {
    text: output,
    redactionEnabled: true,
    redactionCount: redactions.length,
    categoryCounts,
    reasonCounts,
    redactions,
  };
}
