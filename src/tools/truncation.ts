import { stableSort, truncateStable } from "../utils/deterministic";

const FILE_SEARCH_EXCERPT_ELLIPSIS = "…";
const READ_FILE_TRUNCATION_TEMPLATE = "... ‹TRUNCATED: limit=%LIMIT%›";

export interface FileSearchExcerpt {
  line: number;
  excerpt: string;
  match: string;
  [key: string]: unknown;
}

export interface FileSearchResultItem {
  path: string;
  hits: number;
  top_excerpts: FileSearchExcerpt[];
  [key: string]: unknown;
}

export interface FileSearchTruncationLimits {
  maxFiles: number;
  maxExcerptsPerFile: number;
  maxExcerptChars: number;
}

export interface FileSearchTruncationMeta extends FileSearchTruncationLimits {
  truncated: boolean;
  omittedFiles: number;
  omittedExcerpts: number;
}

export interface FileSearchResultPayload {
  pattern: string;
  mode: string;
  results: FileSearchResultItem[];
  truncation?: FileSearchTruncationMeta;
  [key: string]: unknown;
}

export interface CodemapSymbol {
  kind: string;
  signature: string;
  line: number;
  [key: string]: unknown;
}

export interface CodemapResultItem {
  path: string;
  language: string;
  lines: number;
  symbols: CodemapSymbol[];
  truncation?: CodemapFileTruncationMeta;
  [key: string]: unknown;
}

export interface CodemapTruncationLimits {
  maxSymbols: number;
  maxSignatureChars: number;
  maxResults?: number;
}

export interface CodemapFileTruncationMeta {
  max_symbols: number;
  max_signature_chars: number;
  truncated: boolean;
  omitted_symbols: number;
}

export interface CodemapPayloadTruncationMeta {
  max_results?: number;
  truncated: boolean;
  omitted_files: number;
}

export interface CodemapResultPayload {
  paths: string[];
  detail: string;
  results: CodemapResultItem[];
  truncation?: CodemapPayloadTruncationMeta;
  [key: string]: unknown;
}

export interface ReadFileTruncationOptions {
  startLine?: number;
  limit?: number;
  lineNumbers?: boolean;
}

export interface ReadFileTruncationMeta {
  line_numbers: boolean;
  limit: number | null;
  truncated: boolean;
  original_line_count: number;
  returned_line_count: number;
  footer: string | null;
}

export interface ReadFileResultPayload {
  path: string;
  content: string;
  start_line?: number;
  limit?: number;
  line_numbers?: boolean;
  truncation?: ReadFileTruncationMeta;
  [key: string]: unknown;
}

export type FileTreeEntryKind = "file" | "directory";

export interface FileTreeEntry {
  path: string;
  kind: FileTreeEntryKind;
  children?: FileTreeEntry[];
  [key: string]: unknown;
}

export interface FileTreeTruncationLimits {
  maxDepth: number;
  maxEntriesPerLevel: number;
}

export interface FileTreeTruncationMeta extends FileTreeTruncationLimits {
  truncated: boolean;
  omittedEntries: number;
  depthPruned: boolean;
}

export interface FileTreeResultPayload {
  mode: string;
  path?: string;
  entries: FileTreeEntry[];
  truncation?: FileTreeTruncationMeta;
  [key: string]: unknown;
}

export interface ToolTruncationOptions {
  fileSearch?: Partial<FileSearchTruncationLimits>;
  codemap?: Partial<CodemapTruncationLimits>;
  readFile?: ReadFileTruncationOptions;
  fileTree?: Partial<FileTreeTruncationLimits>;
}

export type TruncationSupportedTool =
  | "file_search"
  | "codemap"
  | "read_file"
  | "file_tree";

const DEFAULT_FILE_SEARCH_LIMITS: FileSearchTruncationLimits = {
  maxFiles: 50,
  maxExcerptsPerFile: 3,
  maxExcerptChars: 200,
};

const DEFAULT_CODEMAP_LIMITS: CodemapTruncationLimits = {
  maxSymbols: 200,
  maxSignatureChars: 160,
};

const DEFAULT_FILE_TREE_LIMITS: FileTreeTruncationLimits = {
  maxDepth: 6,
  maxEntriesPerLevel: 200,
};

function readPositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function resolveFileSearchLimits(
  overrides: Partial<FileSearchTruncationLimits> | undefined,
): FileSearchTruncationLimits {
  return {
    maxFiles:
      readPositiveInteger(overrides?.maxFiles) ??
      DEFAULT_FILE_SEARCH_LIMITS.maxFiles,
    maxExcerptsPerFile:
      readPositiveInteger(overrides?.maxExcerptsPerFile) ??
      DEFAULT_FILE_SEARCH_LIMITS.maxExcerptsPerFile,
    maxExcerptChars:
      readPositiveInteger(overrides?.maxExcerptChars) ??
      DEFAULT_FILE_SEARCH_LIMITS.maxExcerptChars,
  };
}

function resolveCodemapLimits(
  overrides: Partial<CodemapTruncationLimits> | undefined,
): CodemapTruncationLimits {
  return {
    maxSymbols:
      readPositiveInteger(overrides?.maxSymbols) ??
      DEFAULT_CODEMAP_LIMITS.maxSymbols,
    maxSignatureChars:
      readPositiveInteger(overrides?.maxSignatureChars) ??
      DEFAULT_CODEMAP_LIMITS.maxSignatureChars,
    maxResults: readPositiveInteger(overrides?.maxResults),
  };
}

function resolveFileTreeLimits(
  overrides: Partial<FileTreeTruncationLimits> | undefined,
): FileTreeTruncationLimits {
  return {
    maxDepth:
      readPositiveInteger(overrides?.maxDepth) ??
      DEFAULT_FILE_TREE_LIMITS.maxDepth,
    maxEntriesPerLevel:
      readPositiveInteger(overrides?.maxEntriesPerLevel) ??
      DEFAULT_FILE_TREE_LIMITS.maxEntriesPerLevel,
  };
}

function compareFileSearchResults(
  left: FileSearchResultItem,
  right: FileSearchResultItem,
): number {
  if (left.hits !== right.hits) {
    return right.hits - left.hits;
  }
  return left.path.localeCompare(right.path);
}

function compareExcerpts(left: FileSearchExcerpt, right: FileSearchExcerpt): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  const matchCompare = left.match.localeCompare(right.match);
  if (matchCompare !== 0) {
    return matchCompare;
  }
  return left.excerpt.localeCompare(right.excerpt);
}

export function enforceFileSearchTruncation(
  payload: FileSearchResultPayload,
  overrides?: Partial<FileSearchTruncationLimits>,
): FileSearchResultPayload {
  const limits = resolveFileSearchLimits(overrides);
  const orderedResults = stableSort(payload.results, compareFileSearchResults);
  const includedResults = orderedResults.slice(0, limits.maxFiles);

  let omittedExcerpts = 0;
  const normalizedResults = includedResults.map((item) => {
    const orderedExcerpts = stableSort(item.top_excerpts, compareExcerpts);
    const includedExcerpts = orderedExcerpts
      .slice(0, limits.maxExcerptsPerFile)
      .map((excerpt) => ({
        ...excerpt,
        excerpt: truncateStable(
          excerpt.excerpt,
          limits.maxExcerptChars,
          FILE_SEARCH_EXCERPT_ELLIPSIS,
        ),
      }));

    omittedExcerpts += Math.max(0, orderedExcerpts.length - includedExcerpts.length);
    return {
      ...item,
      top_excerpts: includedExcerpts,
    };
  });

  const omittedFiles = Math.max(0, orderedResults.length - normalizedResults.length);

  return {
    ...payload,
    results: normalizedResults,
    truncation: {
      ...limits,
      truncated: omittedFiles > 0 || omittedExcerpts > 0,
      omittedFiles,
      omittedExcerpts,
    },
  };
}

function compareCodemapSymbols(left: CodemapSymbol, right: CodemapSymbol): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.signature.localeCompare(right.signature);
}

function compareCodemapResults(left: CodemapResultItem, right: CodemapResultItem): number {
  return left.path.localeCompare(right.path);
}

export function enforceCodemapTruncation(
  payload: CodemapResultPayload,
  overrides?: Partial<CodemapTruncationLimits>,
): CodemapResultPayload {
  const limits = resolveCodemapLimits(overrides);
  const orderedResults = stableSort(payload.results, compareCodemapResults);
  const includedResults =
    limits.maxResults === undefined
      ? orderedResults
      : orderedResults.slice(0, limits.maxResults);

  const normalizedResults = includedResults.map((item) => {
    const orderedSymbols = stableSort(item.symbols, compareCodemapSymbols);
    const includedSymbols = orderedSymbols
      .slice(0, limits.maxSymbols)
      .map((symbol) => ({
        ...symbol,
        signature: truncateStable(symbol.signature, limits.maxSignatureChars),
      }));

    const omittedSymbols = Math.max(0, orderedSymbols.length - includedSymbols.length);
    return {
      ...item,
      symbols: includedSymbols,
      truncation: {
        max_symbols: limits.maxSymbols,
        max_signature_chars: limits.maxSignatureChars,
        truncated: omittedSymbols > 0,
        omitted_symbols: omittedSymbols,
      },
    };
  });

  const omittedFiles = Math.max(0, orderedResults.length - normalizedResults.length);
  const payloadTruncation: CodemapPayloadTruncationMeta = {
    truncated:
      omittedFiles > 0 ||
      normalizedResults.some((item) => item.truncation?.truncated === true),
    omitted_files: omittedFiles,
  };

  if (limits.maxResults !== undefined) {
    payloadTruncation.max_results = limits.maxResults;
  }

  return {
    ...payload,
    results: normalizedResults,
    truncation: payloadTruncation,
  };
}

function splitContentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function normalizeLineLimit(value: number | undefined): number | undefined {
  return readPositiveInteger(value);
}

function renderTruncationFooter(limit: number): string {
  return READ_FILE_TRUNCATION_TEMPLATE.replace("%LIMIT%", String(limit));
}

export function enforceReadFileTruncation(
  payload: ReadFileResultPayload,
  options: ReadFileTruncationOptions = {},
): ReadFileResultPayload {
  const startLine = readPositiveInteger(options.startLine ?? payload.start_line) ?? 1;
  const lineNumbers = options.lineNumbers ?? payload.line_numbers ?? true;
  const limit = normalizeLineLimit(options.limit ?? payload.limit);

  const lines = splitContentLines(payload.content);
  const includedLines = limit === undefined ? lines : lines.slice(0, limit);
  const truncated = limit !== undefined && lines.length > includedLines.length;

  const lastLineNumber = startLine + Math.max(0, includedLines.length - 1);
  const width = Math.max(4, String(lastLineNumber).length);

  const bodyLines = lineNumbers
    ? includedLines.map(
        (line, index) =>
          `${(startLine + index).toString().padStart(width, "0")}| ${line}`,
      )
    : includedLines;

  const footer = truncated && limit !== undefined ? renderTruncationFooter(limit) : null;
  const outputLines = footer === null ? bodyLines : [...bodyLines, footer];
  const content =
    outputLines.length === 0 ? "" : `${outputLines.join("\n").replace(/\n*$/u, "")}\n`;

  return {
    ...payload,
    start_line: startLine,
    limit,
    line_numbers: lineNumbers,
    content,
    truncation: {
      line_numbers: lineNumbers,
      limit: limit ?? null,
      truncated,
      original_line_count: lines.length,
      returned_line_count: includedLines.length,
      footer,
    },
  };
}

function compareFileTreeEntries(left: FileTreeEntry, right: FileTreeEntry): number {
  const pathCompare = left.path.localeCompare(right.path);
  if (pathCompare !== 0) {
    return pathCompare;
  }
  return left.kind.localeCompare(right.kind);
}

function countTreeEntries(entries: readonly FileTreeEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += 1;
    if (Array.isArray(entry.children) && entry.children.length > 0) {
      total += countTreeEntries(entry.children);
    }
  }
  return total;
}

function cloneTreeEntry(
  entry: FileTreeEntry,
  children?: FileTreeEntry[],
): FileTreeEntry {
  const cloned: FileTreeEntry = { ...entry };
  if (children === undefined) {
    delete cloned.children;
  } else {
    cloned.children = children;
  }
  return cloned;
}

interface FileTreeTraversalState {
  omittedEntries: number;
  depthPruned: boolean;
}

function truncateTreeEntries(
  entries: readonly FileTreeEntry[],
  depth: number,
  limits: FileTreeTruncationLimits,
  state: FileTreeTraversalState,
): FileTreeEntry[] {
  const orderedEntries = stableSort(entries, compareFileTreeEntries);
  const includedEntries = orderedEntries.slice(0, limits.maxEntriesPerLevel);

  const omittedEntries = orderedEntries.slice(includedEntries.length);
  state.omittedEntries += omittedEntries.length;
  for (const omitted of omittedEntries) {
    if (Array.isArray(omitted.children) && omitted.children.length > 0) {
      state.omittedEntries += countTreeEntries(omitted.children);
    }
  }

  const output: FileTreeEntry[] = [];
  for (const entry of includedEntries) {
    const children = Array.isArray(entry.children) ? entry.children : undefined;
    if (!children || children.length === 0) {
      output.push(cloneTreeEntry(entry));
      continue;
    }

    if (depth >= limits.maxDepth) {
      state.depthPruned = true;
      state.omittedEntries += countTreeEntries(children);
      output.push(cloneTreeEntry(entry));
      continue;
    }

    const nextChildren = truncateTreeEntries(children, depth + 1, limits, state);
    output.push(cloneTreeEntry(entry, nextChildren));
  }

  return output;
}

export function enforceFileTreeTruncation(
  payload: FileTreeResultPayload,
  overrides?: Partial<FileTreeTruncationLimits>,
): FileTreeResultPayload {
  const limits = resolveFileTreeLimits(overrides);
  const traversalState: FileTreeTraversalState = {
    omittedEntries: 0,
    depthPruned: false,
  };

  const entries = truncateTreeEntries(payload.entries, 1, limits, traversalState);

  return {
    ...payload,
    entries,
    truncation: {
      ...limits,
      truncated: traversalState.omittedEntries > 0 || traversalState.depthPruned,
      omittedEntries: traversalState.omittedEntries,
      depthPruned: traversalState.depthPruned,
    },
  };
}

export function enforceDeterministicToolTruncation(
  tool: "file_search",
  payload: FileSearchResultPayload,
  options?: ToolTruncationOptions,
): FileSearchResultPayload;
export function enforceDeterministicToolTruncation(
  tool: "codemap",
  payload: CodemapResultPayload,
  options?: ToolTruncationOptions,
): CodemapResultPayload;
export function enforceDeterministicToolTruncation(
  tool: "read_file",
  payload: ReadFileResultPayload,
  options?: ToolTruncationOptions,
): ReadFileResultPayload;
export function enforceDeterministicToolTruncation(
  tool: "file_tree",
  payload: FileTreeResultPayload,
  options?: ToolTruncationOptions,
): FileTreeResultPayload;
export function enforceDeterministicToolTruncation(
  tool: TruncationSupportedTool,
  payload:
    | FileSearchResultPayload
    | CodemapResultPayload
    | ReadFileResultPayload
    | FileTreeResultPayload,
  options: ToolTruncationOptions = {},
):
  | FileSearchResultPayload
  | CodemapResultPayload
  | ReadFileResultPayload
  | FileTreeResultPayload {
  switch (tool) {
    case "file_search":
      return enforceFileSearchTruncation(payload, options.fileSearch);
    case "codemap":
      return enforceCodemapTruncation(payload, options.codemap);
    case "read_file":
      return enforceReadFileTruncation(payload, options.readFile);
    case "file_tree":
      return enforceFileTreeTruncation(payload, options.fileTree);
  }
}
