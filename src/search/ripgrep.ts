import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { extname } from "node:path";
import { matchGlob } from "../utils/paths";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_COUNT_PER_FILE = 20;
const DEFAULT_MAX_FILE_SIZE_BYTES = 1_500_000;
const DEFAULT_MAX_RESULTS = 100;

type SpawnSyncLike = typeof spawnSync;

export type RipgrepErrorCode =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "SPAWN_ERROR"
  | "RG_FAILED"
  | "PARSE_ERROR";

export interface RipgrepError {
  code: RipgrepErrorCode;
  message: string;
}

export interface RipgrepBaseOptions {
  cwd: string;
  regex?: boolean;
  extensions?: string[];
  pathFilter?: string[];
  exclude?: string[];
  maxResults?: number;
  timeoutMs?: number;
  rgPath?: string;
  spawnSyncImpl?: SpawnSyncLike;
}

export interface SearchContentOptions extends RipgrepBaseOptions {
  contextLines?: number;
  maxCountPerFile?: number;
  maxFileSizeBytes?: number;
}

export interface SearchPathOptions extends RipgrepBaseOptions {}

export interface SearchContentHit {
  path: string;
  line: number;
  column: number;
  excerpt: string;
  submatches: string[];
  beforeContext: string[];
  afterContext: string[];
}

export interface SearchContentResponse {
  ok: boolean;
  available: boolean;
  hits: SearchContentHit[];
  stderr: string;
  error?: RipgrepError;
}

export interface SearchPathResponse {
  ok: boolean;
  available: boolean;
  paths: string[];
  stderr: string;
  error?: RipgrepError;
}

interface JsonTextField {
  text?: string;
}

interface RgMatchSubmatch {
  match?: JsonTextField;
  start?: number;
  end?: number;
}

interface RgJsonData {
  path?: JsonTextField;
  line_number?: number;
  lines?: JsonTextField;
  submatches?: RgMatchSubmatch[];
}

interface RgJsonEvent {
  type?: string;
  data?: RgJsonData;
}

function normalizeSpawnErrorCode(result: SpawnSyncReturns<string>): string | undefined {
  if (!result.error || typeof result.error !== "object" || !("code" in result.error)) {
    return undefined;
  }
  return String(result.error.code ?? "");
}

function trimLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function normalizeMaxResults(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return DEFAULT_MAX_RESULTS;
}

function normalizeMaxCountPerFile(value: number | undefined): number {
  return readPositiveInteger(value, DEFAULT_MAX_COUNT_PER_FILE);
}

function normalizeMaxFileSizeBytes(value: number | undefined): number {
  return readPositiveInteger(value, DEFAULT_MAX_FILE_SIZE_BYTES);
}

function normalizeCandidatePath(pathValue: string): string {
  const normalized = pathValue.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

interface PathFilters {
  extensions: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
}

function buildPathFilters(options: RipgrepBaseOptions): PathFilters {
  return {
    extensions: (options.extensions ?? [])
      .map((extension) => normalizeExtension(extension))
      .filter((extension) => extension.length > 0),
    includeGlobs: (options.pathFilter ?? [])
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0),
    excludeGlobs: (options.exclude ?? [])
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0),
  };
}

function pathMatchesFilters(pathValue: string, filters: PathFilters): boolean {
  if (filters.extensions.length > 0) {
    const candidateExtension = extname(pathValue).toLowerCase();
    if (!filters.extensions.includes(candidateExtension)) {
      return false;
    }
  }
  if (
    filters.includeGlobs.length > 0 &&
    !filters.includeGlobs.some((pattern) => matchGlob(pathValue, pattern))
  ) {
    return false;
  }
  if (filters.excludeGlobs.some((pattern) => matchGlob(pathValue, pattern))) {
    return false;
  }
  return true;
}

function buildGlobArgs(options: RipgrepBaseOptions): string[] {
  const args: string[] = [];

  for (const extension of options.extensions ?? []) {
    const trimmed = extension.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
    if (normalized.length === 0) {
      continue;
    }
    args.push("-g", `*.${normalized}`);
  }

  for (const includePattern of options.pathFilter ?? []) {
    const trimmed = includePattern.trim();
    if (trimmed.length === 0) {
      continue;
    }
    args.push("-g", trimmed);
  }

  for (const excludePattern of options.exclude ?? []) {
    const trimmed = excludePattern.trim();
    if (trimmed.length === 0) {
      continue;
    }
    args.push("-g", `!${trimmed}`);
  }

  return args;
}

function spawnRg(
  args: string[],
  options: RipgrepBaseOptions,
): SpawnSyncReturns<string> {
  const spawnImpl = options.spawnSyncImpl ?? spawnSync;
  const rgPath = options.rgPath ?? "rg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  };

  return spawnImpl(rgPath, args, spawnOptions);
}

function spawnFailureResponse(
  stderr: string,
  result: SpawnSyncReturns<string>,
): SearchContentResponse {
  const errorCode = normalizeSpawnErrorCode(result);
  if (errorCode === "ENOENT") {
    return {
      ok: false,
      available: false,
      hits: [],
      stderr,
      error: {
        code: "UNAVAILABLE",
        message: "ripgrep executable not found in PATH",
      },
    };
  }

  if (errorCode === "ETIMEDOUT") {
    return {
      ok: false,
      available: true,
      hits: [],
      stderr,
      error: {
        code: "TIMEOUT",
        message: "ripgrep search timed out",
      },
    };
  }

  return {
    ok: false,
    available: true,
    hits: [],
    stderr,
    error: {
      code: "SPAWN_ERROR",
      message: "failed to execute ripgrep",
    },
  };
}

function parseJsonEvents(stdout: string): { ok: true; events: RgJsonEvent[] } | { ok: false } {
  const events: RgJsonEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as RgJsonEvent);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, events };
}

export function isRipgrepAvailable(
  options: {
    cwd?: string;
    rgPath?: string;
    spawnSyncImpl?: SpawnSyncLike;
  } = {},
): boolean {
  const spawnImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnImpl(options.rgPath ?? "rg", ["--version"], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: 2_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  if (normalizeSpawnErrorCode(result) === "ENOENT") {
    return false;
  }

  return result.status === 0;
}

export function searchContent(
  pattern: string,
  options: SearchContentOptions,
): SearchContentResponse {
  const maxResults = normalizeMaxResults(options.maxResults);
  const contextLines = readPositiveInteger(options.contextLines, 0);
  const pathFilters = buildPathFilters(options);

  const args = [
    "--json",
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--max-count",
    String(normalizeMaxCountPerFile(options.maxCountPerFile)),
    "--max-filesize",
    String(normalizeMaxFileSizeBytes(options.maxFileSizeBytes)),
    ...buildGlobArgs(options),
  ];

  if (contextLines > 0) {
    args.push("--context", String(contextLines));
  }
  if (!options.regex) {
    args.push("--fixed-strings");
  }
  args.push("--", pattern, ".");

  const result = spawnRg(args, options);
  const stderr = result.stderr ?? "";

  if (result.error) {
    return spawnFailureResponse(stderr, result);
  }

  const status = result.status ?? 1;
  if (status !== 0 && status !== 1) {
    return {
      ok: false,
      available: true,
      hits: [],
      stderr,
      error: {
        code: "RG_FAILED",
        message: "ripgrep exited with non-zero status",
      },
    };
  }

  const stdout = result.stdout ?? "";
  if (stdout.trim().length === 0) {
    return {
      ok: true,
      available: true,
      hits: [],
      stderr,
    };
  }

  const parsed = parseJsonEvents(stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      available: true,
      hits: [],
      stderr,
      error: {
        code: "PARSE_ERROR",
        message: "failed to parse ripgrep JSON output",
      },
    };
  }

  const hits: SearchContentHit[] = [];
  const pendingBeforeByPath = new Map<string, string[]>();
  const lastMatchIndexByPath = new Map<string, number>();

  for (const event of parsed.events) {
    if (hits.length >= maxResults) {
      break;
    }

    const data = event.data;
    const rawPath = data?.path?.text;
    if (!rawPath || rawPath.trim().length === 0) {
      continue;
    }

    const path = normalizeCandidatePath(rawPath);
    if (path.length === 0 || !pathMatchesFilters(path, pathFilters)) {
      continue;
    }

    if (event.type === "context") {
      const contextText = trimLineEnding(data?.lines?.text ?? "");
      if (contextText.length === 0) {
        continue;
      }

      const lastMatchIndex = lastMatchIndexByPath.get(path);
      if (lastMatchIndex !== undefined) {
        const lastHit = hits[lastMatchIndex];
        if (
          lastHit &&
          (contextLines === 0 || lastHit.afterContext.length < contextLines)
        ) {
          lastHit.afterContext.push(contextText);
          continue;
        }
      }

      const pending = pendingBeforeByPath.get(path) ?? [];
      pending.push(contextText);
      if (contextLines > 0 && pending.length > contextLines) {
        pending.shift();
      }
      pendingBeforeByPath.set(path, pending);
      continue;
    }

    if (event.type !== "match") {
      continue;
    }

    const lineNumber = data?.line_number;
    if (!Number.isInteger(lineNumber) || (lineNumber as number) < 1) {
      continue;
    }

    const excerpt = trimLineEnding(data?.lines?.text ?? "");
    const beforeContext = pendingBeforeByPath.get(path) ?? [];
    pendingBeforeByPath.set(path, []);

    const submatches = (data?.submatches ?? [])
      .map((submatch) => submatch.match?.text ?? "")
      .filter((text) => text.length > 0);
    const firstColumn = (data?.submatches ?? [])[0]?.start;

    const hit: SearchContentHit = {
      path,
      line: lineNumber as number,
      column:
        typeof firstColumn === "number" && firstColumn >= 0
          ? firstColumn + 1
          : 1,
      excerpt,
      submatches,
      beforeContext: [...beforeContext],
      afterContext: [],
    };

    hits.push(hit);
    lastMatchIndexByPath.set(path, hits.length - 1);
  }

  return {
    ok: true,
    available: true,
    hits,
    stderr,
  };
}

export function searchPaths(
  pattern: string,
  options: SearchPathOptions,
): SearchPathResponse {
  const maxResults = normalizeMaxResults(options.maxResults);
  const pathFilters = buildPathFilters(options);
  const args = ["--files", "--color", "never", ...buildGlobArgs(options)];

  const result = spawnRg(args, options);
  const stderr = result.stderr ?? "";

  if (result.error) {
    const contentResponse = spawnFailureResponse(stderr, result);
    return {
      ok: contentResponse.ok,
      available: contentResponse.available,
      paths: [],
      stderr: contentResponse.stderr,
      error: contentResponse.error,
    };
  }

  const status = result.status ?? 1;
  if (status !== 0) {
    return {
      ok: false,
      available: true,
      paths: [],
      stderr,
      error: {
        code: "RG_FAILED",
        message: "ripgrep path search failed",
      },
    };
  }

  const allPaths = (result.stdout ?? "")
    .split("\n")
    .map((line) => normalizeCandidatePath(line.trim()))
    .filter((line) => line.length > 0);

  let matcher: (candidate: string) => boolean;
  if (options.regex) {
    try {
      const patternRegex = new RegExp(pattern);
      matcher = (candidate) => patternRegex.test(candidate);
    } catch {
      return {
        ok: false,
        available: true,
        paths: [],
        stderr,
        error: {
          code: "PARSE_ERROR",
          message: "invalid regex pattern for path search",
        },
      };
    }
  } else {
    const lowerPattern = pattern.toLowerCase();
    matcher = (candidate) => candidate.toLowerCase().includes(lowerPattern);
  }

  const filtered = [...new Set(allPaths)]
    .filter((candidate) => pathMatchesFilters(candidate, pathFilters))
    .filter((candidate) => matcher(candidate))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxResults);

  return {
    ok: true,
    available: true,
    paths: filtered,
    stderr,
  };
}
