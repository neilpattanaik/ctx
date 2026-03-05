import {
  formatContentSearchResults,
  isRipgrepAvailable,
  searchContent,
  searchContentFallback,
  searchPaths,
  searchPathsFallback,
  type SearchContentOptions,
  type SearchContentResponse,
  type SearchPathOptions,
  type SearchPathResponse,
} from "../search";
import { stableSort } from "../utils/deterministic";
import {
  enforceFileSearchTruncation,
  type FileSearchResultItem,
  type FileSearchResultPayload,
  type FileSearchTruncationLimits,
} from "./truncation";

const FILE_SEARCH_MODES = ["content", "path", "both", "auto"] as const;
const DEFAULT_MODE: FileSearchMode = "auto";
const DEFAULT_CONTEXT_LINES = 0;
const DEFAULT_MAX_RESULTS = 50;
const UNLIMITED_FILES_CAP = Number.MAX_SAFE_INTEGER;

export type FileSearchMode = (typeof FILE_SEARCH_MODES)[number];
type ResolvedFileSearchMode = Exclude<FileSearchMode, "auto">;

export const FILE_SEARCH_TOOL_ERROR_CODES = [
  "INVALID_ARGS",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type FileSearchToolErrorCode = (typeof FILE_SEARCH_TOOL_ERROR_CODES)[number];

export class FileSearchToolError extends Error {
  code: FileSearchToolErrorCode;

  constructor(code: FileSearchToolErrorCode, message: string) {
    super(message);
    this.name = "FileSearchToolError";
    this.code = code;
  }
}

export interface FileSearchFilterArgs {
  extensions?: string[];
  paths?: string[];
  exclude?: string[];
}

export interface FileSearchArgs {
  pattern: string;
  mode?: FileSearchMode;
  regex?: boolean;
  filter?: FileSearchFilterArgs;
  context_lines?: number;
  max_results?: number;
}

export interface FileSearchValidationResultOk {
  ok: true;
}

export interface FileSearchValidationResultErr {
  ok: false;
  message: string;
}

export type FileSearchValidationResult =
  | FileSearchValidationResultOk
  | FileSearchValidationResultErr;

export interface FileSearchToolsContext {
  cwd: string;
  repoFiles?: readonly string[];
  defaultMode?: FileSearchMode;
  defaultContextLines?: number;
  defaultMaxResults?: number;
  maxExcerptsPerFile?: number;
  maxExcerptChars?: number;
  isRipgrepAvailableImpl?: typeof isRipgrepAvailable;
  searchContentImpl?: typeof searchContent;
  searchPathsImpl?: typeof searchPaths;
  searchContentFallbackImpl?: typeof searchContentFallback;
  searchPathsFallbackImpl?: typeof searchPathsFallback;
}

interface NormalizedFileSearchFilter {
  extensions: string[];
  paths: string[];
  exclude: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeStringList(values: unknown): string[] | null {
  if (!Array.isArray(values)) {
    return null;
  }

  const normalized: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      return null;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      return null;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeFilter(
  filter: FileSearchFilterArgs | undefined,
): NormalizedFileSearchFilter {
  const extensions = (filter?.extensions ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const paths = (filter?.paths ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const exclude = (filter?.exclude ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    extensions,
    paths,
    exclude,
  };
}

function parseFilterArgs(
  value: unknown,
): { ok: true; filter: FileSearchFilterArgs | undefined } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, filter: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "args.filter must be an object when provided" };
  }

  if (value.extensions !== undefined && normalizeStringList(value.extensions) === null) {
    return {
      ok: false,
      message: "args.filter.extensions must be an array of non-empty strings",
    };
  }

  if (value.paths !== undefined && normalizeStringList(value.paths) === null) {
    return {
      ok: false,
      message: "args.filter.paths must be an array of non-empty strings",
    };
  }

  if (value.exclude !== undefined && normalizeStringList(value.exclude) === null) {
    return {
      ok: false,
      message: "args.filter.exclude must be an array of non-empty strings",
    };
  }

  return {
    ok: true,
    filter: {
      extensions:
        value.extensions === undefined ? undefined : normalizeStringList(value.extensions) ?? [],
      paths: value.paths === undefined ? undefined : normalizeStringList(value.paths) ?? [],
      exclude: value.exclude === undefined ? undefined : normalizeStringList(value.exclude) ?? [],
    },
  };
}

function resolveMode(
  mode: FileSearchMode | undefined,
  pattern: string,
  defaultMode: FileSearchMode,
): ResolvedFileSearchMode {
  const requestedMode = mode ?? defaultMode;
  if (requestedMode !== "auto") {
    return requestedMode;
  }

  if (pattern.includes("/") || pattern.includes(".")) {
    return "both";
  }
  return "content";
}

function resolveContextLines(
  value: number | undefined,
  defaultContextLines: number | undefined,
): number {
  const parsedValue = readNonNegativeInteger(value);
  if (parsedValue !== null) {
    return parsedValue;
  }

  const parsedDefault = readNonNegativeInteger(defaultContextLines);
  if (parsedDefault !== null) {
    return parsedDefault;
  }
  return DEFAULT_CONTEXT_LINES;
}

function resolveMaxResults(
  value: number | undefined,
  defaultMaxResults: number | undefined,
): number {
  const parsedValue = readPositiveInteger(value);
  if (parsedValue !== null) {
    return parsedValue;
  }

  const parsedDefault = readPositiveInteger(defaultMaxResults);
  if (parsedDefault !== null) {
    return parsedDefault;
  }
  return DEFAULT_MAX_RESULTS;
}

function compareResults(left: FileSearchResultItem, right: FileSearchResultItem): number {
  if (left.hits !== right.hits) {
    return right.hits - left.hits;
  }
  return left.path.localeCompare(right.path);
}

function buildPathResults(paths: readonly string[]): FileSearchResultItem[] {
  const deduped = [...new Set(paths)];
  return stableSort(deduped, (left, right) => left.localeCompare(right)).map((path) => ({
    path,
    hits: 1,
    top_excerpts: [],
  }));
}

function mergeResults(
  contentResults: readonly FileSearchResultItem[],
  pathResults: readonly FileSearchResultItem[],
): FileSearchResultItem[] {
  const merged = new Map<string, FileSearchResultItem>();
  for (const item of contentResults) {
    merged.set(item.path, {
      path: item.path,
      hits: item.hits,
      top_excerpts: item.top_excerpts.map((excerpt) => ({ ...excerpt })),
    });
  }

  for (const item of pathResults) {
    const existing = merged.get(item.path);
    if (existing) {
      existing.hits += item.hits;
      continue;
    }
    merged.set(item.path, {
      path: item.path,
      hits: item.hits,
      top_excerpts: [],
    });
  }

  return stableSort([...merged.values()], compareResults);
}

function resolveTruncationLimits(
  maxResults: number,
  context: FileSearchToolsContext,
): Partial<FileSearchTruncationLimits> {
  const limits: Partial<FileSearchTruncationLimits> = {
    maxFiles: maxResults,
  };

  if (readPositiveInteger(context.maxExcerptsPerFile) !== null) {
    limits.maxExcerptsPerFile = context.maxExcerptsPerFile;
  }
  if (readPositiveInteger(context.maxExcerptChars) !== null) {
    limits.maxExcerptChars = context.maxExcerptChars;
  }
  return limits;
}

function mapSearchErrorToToolError(
  response: SearchContentResponse | SearchPathResponse,
): never {
  const error = response.error;
  if (!error) {
    throw new FileSearchToolError("INTERNAL_ERROR", "search backend returned an unknown error");
  }

  if (error.code === "PARSE_ERROR") {
    throw new FileSearchToolError("INVALID_ARGS", error.message);
  }
  if (error.code === "UNAVAILABLE") {
    throw new FileSearchToolError("UNAVAILABLE", error.message);
  }

  throw new FileSearchToolError("INTERNAL_ERROR", error.message);
}

function resolveSearchBackend(context: FileSearchToolsContext): "ripgrep" | "fallback" {
  const availabilityChecker = context.isRipgrepAvailableImpl ?? isRipgrepAvailable;
  const available = availabilityChecker({
    cwd: context.cwd,
  });
  return available ? "ripgrep" : "fallback";
}

function buildSearchBaseOptions(
  context: FileSearchToolsContext,
  filter: NormalizedFileSearchFilter,
  regex: boolean,
  maxResults: number,
): Pick<SearchContentOptions, "cwd" | "regex" | "extensions" | "pathFilter" | "exclude" | "maxResults"> {
  return {
    cwd: context.cwd,
    regex,
    extensions: filter.extensions,
    pathFilter: filter.paths,
    exclude: filter.exclude,
    maxResults,
  };
}

function runContentSearch(
  pattern: string,
  options: SearchContentOptions,
  context: FileSearchToolsContext,
  backend: "ripgrep" | "fallback",
): SearchContentResponse {
  if (backend === "ripgrep") {
    const searchImpl = context.searchContentImpl ?? searchContent;
    return searchImpl(pattern, options);
  }

  const repoFiles = context.repoFiles;
  if (!repoFiles) {
    throw new FileSearchToolError(
      "UNAVAILABLE",
      "file_search fallback requires repoFiles when ripgrep is unavailable",
    );
  }

  const fallbackImpl = context.searchContentFallbackImpl ?? searchContentFallback;
  return fallbackImpl(pattern, {
    ...options,
    files: repoFiles,
  });
}

function runPathSearch(
  pattern: string,
  options: SearchPathOptions,
  context: FileSearchToolsContext,
  backend: "ripgrep" | "fallback",
): SearchPathResponse {
  if (backend === "ripgrep") {
    const searchImpl = context.searchPathsImpl ?? searchPaths;
    return searchImpl(pattern, options);
  }

  const repoFiles = context.repoFiles;
  if (!repoFiles) {
    throw new FileSearchToolError(
      "UNAVAILABLE",
      "file_search fallback requires repoFiles when ripgrep is unavailable",
    );
  }

  const fallbackImpl = context.searchPathsFallbackImpl ?? searchPathsFallback;
  return fallbackImpl(pattern, {
    ...options,
    files: repoFiles,
  });
}

function parseArgs(args: FileSearchArgs): {
  pattern: string;
  mode: FileSearchMode | undefined;
  regex: boolean;
  filter: FileSearchFilterArgs | undefined;
  contextLines: number | undefined;
  maxResults: number | undefined;
} {
  const filterResult = parseFilterArgs(args.filter);
  if (!filterResult.ok) {
    throw new FileSearchToolError("INVALID_ARGS", filterResult.message);
  }

  return {
    pattern: args.pattern.trim(),
    mode: args.mode,
    regex: args.regex ?? false,
    filter: filterResult.filter,
    contextLines: args.context_lines,
    maxResults: args.max_results,
  };
}

export function validateFileSearchArgs(args: unknown): FileSearchValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) {
    return { ok: false, message: "args.pattern must be a non-empty string" };
  }

  if (
    args.mode !== undefined &&
    (typeof args.mode !== "string" ||
      !FILE_SEARCH_MODES.includes(args.mode as FileSearchMode))
  ) {
    return {
      ok: false,
      message: "args.mode must be one of: content, path, both, auto",
    };
  }

  if (args.regex !== undefined && typeof args.regex !== "boolean") {
    return { ok: false, message: "args.regex must be a boolean" };
  }

  const filterResult = parseFilterArgs(args.filter);
  if (!filterResult.ok) {
    return { ok: false, message: filterResult.message };
  }

  if (
    args.context_lines !== undefined &&
    readNonNegativeInteger(args.context_lines) === null
  ) {
    return { ok: false, message: "args.context_lines must be a non-negative integer" };
  }

  if (args.max_results !== undefined && readPositiveInteger(args.max_results) === null) {
    return { ok: false, message: "args.max_results must be a positive integer" };
  }

  if (args.regex === true) {
    try {
      // Validate early to produce INVALID_ARGS before backend invocation.
      new RegExp(args.pattern);
    } catch {
      return { ok: false, message: "args.pattern must be a valid regex when args.regex=true" };
    }
  }

  return { ok: true };
}

export function executeFileSearch(
  args: FileSearchArgs,
  context: FileSearchToolsContext,
): FileSearchResultPayload {
  const parsed = parseArgs(args);
  if (parsed.pattern.length === 0) {
    throw new FileSearchToolError("INVALID_ARGS", "args.pattern must be a non-empty string");
  }

  const resolvedMode = resolveMode(parsed.mode, parsed.pattern, context.defaultMode ?? DEFAULT_MODE);
  const contextLines = resolveContextLines(parsed.contextLines, context.defaultContextLines);
  const maxResults = resolveMaxResults(parsed.maxResults, context.defaultMaxResults);
  const normalizedFilter = normalizeFilter(parsed.filter);
  const backend = resolveSearchBackend(context);

  const baseOptions = buildSearchBaseOptions(
    context,
    normalizedFilter,
    parsed.regex,
    maxResults,
  );

  let contentResults: FileSearchResultItem[] = [];
  if (resolvedMode === "content" || resolvedMode === "both") {
    const contentResponse = runContentSearch(
      parsed.pattern,
      {
        ...baseOptions,
        contextLines,
      },
      context,
      backend,
    );
    if (!contentResponse.ok) {
      mapSearchErrorToToolError(contentResponse);
    }

    const formatted = formatContentSearchResults(parsed.pattern, contentResponse.hits, {
      maxFiles: UNLIMITED_FILES_CAP,
      maxExcerptsPerFile: context.maxExcerptsPerFile,
      maxExcerptChars: context.maxExcerptChars,
    });
    contentResults = formatted.results;
  }

  let pathResults: FileSearchResultItem[] = [];
  if (resolvedMode === "path" || resolvedMode === "both") {
    const pathResponse = runPathSearch(parsed.pattern, baseOptions, context, backend);
    if (!pathResponse.ok) {
      mapSearchErrorToToolError(pathResponse);
    }
    pathResults = buildPathResults(pathResponse.paths);
  }

  const merged =
    resolvedMode === "both"
      ? mergeResults(contentResults, pathResults)
      : resolvedMode === "content"
        ? stableSort(contentResults, compareResults)
        : stableSort(pathResults, compareResults);

  return enforceFileSearchTruncation(
    {
      pattern: parsed.pattern,
      mode: resolvedMode,
      results: merged,
    },
    resolveTruncationLimits(maxResults, context),
  );
}
