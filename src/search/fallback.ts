import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { matchGlob } from "../utils/paths";
import type {
  RipgrepBaseOptions,
  SearchContentHit,
  SearchContentResponse,
  SearchPathResponse,
} from "./ripgrep";

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_COUNT_PER_FILE = 20;

export interface FallbackSearchBaseOptions extends Omit<RipgrepBaseOptions, "timeoutMs" | "rgPath" | "spawnSyncImpl"> {
  files: readonly string[];
}

export interface FallbackSearchContentOptions extends FallbackSearchBaseOptions {
  contextLines?: number;
  maxCountPerFile?: number;
}

export interface FallbackSearchPathOptions extends FallbackSearchBaseOptions {}

function normalizeMaxResults(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return DEFAULT_MAX_RESULTS;
}

function normalizeMaxCountPerFile(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return DEFAULT_MAX_COUNT_PER_FILE;
}

function normalizeContextLines(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return 0;
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function filterCandidateFiles(options: FallbackSearchBaseOptions): string[] {
  const allowedExtensions = (options.extensions ?? [])
    .map((extension) => normalizeExtension(extension))
    .filter((extension) => extension.length > 0);
  const includeGlobs = (options.pathFilter ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  const excludeGlobs = (options.exclude ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);

  return [...options.files]
    .filter((candidatePath) => {
      if (allowedExtensions.length > 0) {
        const candidateExtension = extname(candidatePath).toLowerCase();
        if (!allowedExtensions.includes(candidateExtension)) {
          return false;
        }
      }
      if (includeGlobs.length > 0 && !includeGlobs.some((pattern) => matchGlob(candidatePath, pattern))) {
        return false;
      }
      if (excludeGlobs.some((pattern) => matchGlob(candidatePath, pattern))) {
        return false;
      }
      return true;
    })
    .sort((left, right) => left.localeCompare(right));
}

function buildMatcher(
  pattern: string,
  regex: boolean | undefined,
): {
  ok: true;
  testLine: (line: string) => { matched: boolean; column: number; submatches: string[] };
  testPath: (candidate: string) => boolean;
} | {
  ok: false;
  message: string;
} {
  if (regex) {
    let patternRegex: RegExp;
    try {
      patternRegex = new RegExp(pattern);
    } catch {
      return {
        ok: false,
        message: "invalid regex pattern",
      };
    }

    return {
      ok: true,
      testLine: (line) => {
        const match = patternRegex.exec(line);
        if (!match || match.index < 0) {
          return { matched: false, column: 0, submatches: [] };
        }
        const matchText = match[0] ?? "";
        return {
          matched: true,
          column: match.index + 1,
          submatches: matchText.length > 0 ? [matchText] : [],
        };
      },
      testPath: (candidate) => patternRegex.test(candidate),
    };
  }

  const lowerPattern = pattern.toLowerCase();
  return {
    ok: true,
    testLine: (line) => {
      const index = line.toLowerCase().indexOf(lowerPattern);
      if (index < 0) {
        return { matched: false, column: 0, submatches: [] };
      }
      return {
        matched: true,
        column: index + 1,
        submatches: [line.slice(index, index + lowerPattern.length)],
      };
    },
    testPath: (candidate) => candidate.toLowerCase().includes(lowerPattern),
  };
}

function parseLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function buildParseErrorResponse(message: string): SearchContentResponse {
  return {
    ok: false,
    available: true,
    hits: [],
    stderr: "",
    error: {
      code: "PARSE_ERROR",
      message,
    },
  };
}

function buildPathParseErrorResponse(message: string): SearchPathResponse {
  return {
    ok: false,
    available: true,
    paths: [],
    stderr: "",
    error: {
      code: "PARSE_ERROR",
      message,
    },
  };
}

export function searchContentFallback(
  pattern: string,
  options: FallbackSearchContentOptions,
): SearchContentResponse {
  const matcher = buildMatcher(pattern, options.regex);
  if (!matcher.ok) {
    return buildParseErrorResponse(matcher.message);
  }

  const maxResults = normalizeMaxResults(options.maxResults);
  const maxCountPerFile = normalizeMaxCountPerFile(options.maxCountPerFile);
  const contextLines = normalizeContextLines(options.contextLines);
  const candidateFiles = filterCandidateFiles(options);
  const hits: SearchContentHit[] = [];

  for (const relativePath of candidateFiles) {
    if (hits.length >= maxResults) {
      break;
    }

    let content: string;
    try {
      content = readFileSync(`${options.cwd}/${relativePath}`, "utf8");
    } catch {
      continue;
    }

    const lines = parseLines(content);
    let fileHitCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= maxResults || fileHitCount >= maxCountPerFile) {
        break;
      }

      const line = lines[index] ?? "";
      const result = matcher.testLine(line);
      if (!result.matched) {
        continue;
      }

      const beforeContext = [];
      const afterContext = [];
      for (let offset = contextLines; offset >= 1; offset -= 1) {
        const before = lines[index - offset];
        if (before !== undefined) {
          beforeContext.push(before);
        }
      }
      for (let offset = 1; offset <= contextLines; offset += 1) {
        const after = lines[index + offset];
        if (after !== undefined) {
          afterContext.push(after);
        }
      }

      hits.push({
        path: relativePath,
        line: index + 1,
        column: result.column,
        excerpt: line,
        submatches: result.submatches,
        beforeContext,
        afterContext,
      });
      fileHitCount += 1;
    }
  }

  return {
    ok: true,
    available: true,
    hits,
    stderr: "",
  };
}

export function searchPathsFallback(
  pattern: string,
  options: FallbackSearchPathOptions,
): SearchPathResponse {
  const matcher = buildMatcher(pattern, options.regex);
  if (!matcher.ok) {
    return buildPathParseErrorResponse(matcher.message);
  }

  const maxResults = normalizeMaxResults(options.maxResults);
  const candidateFiles = filterCandidateFiles(options);
  const filteredPaths = candidateFiles
    .filter((candidatePath) => matcher.testPath(candidatePath))
    .slice(0, maxResults);

  return {
    ok: true,
    available: true,
    paths: filteredPaths,
    stderr: "",
  };
}
