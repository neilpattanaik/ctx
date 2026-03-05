import { resolve } from "node:path";
import {
  SelectionManager,
  type ManagedSelectionEntry,
  type SelectionAddOptions,
} from "../selection";
import type { SelectionPriority, SliceRange } from "../types";
import { DEFAULT_CHARS_PER_TOKEN } from "../utils/token-estimate";
import { isSubpath, normalizePath, toAbsolute } from "../utils/paths";

const SELECT_GET_VIEWS = ["summary", "files", "content", "codemaps"] as const;
const SELECTION_MODES = ["full", "slices", "codemap_only"] as const;
const SELECTION_PRIORITIES = ["core", "support", "ref"] as const;
const DEFAULT_SLICE_CHARS_PER_LINE = 80;
const DEFAULT_CODEMAP_ONLY_TOKENS = 120;

export type SelectionView = (typeof SELECT_GET_VIEWS)[number];
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const SELECTION_TOOL_ERROR_CODES = [
  "INVALID_ARGS",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "INVALID_SELECTION_ENTRY",
  "MAX_FILES_EXCEEDED",
  "MAX_FULL_FILES_EXCEEDED",
  "BINARY_FILE_EXCLUDED",
  "FILE_TOO_LARGE",
  "NEVER_INCLUDE_MATCH",
] as const;

export type SelectionToolErrorCode = (typeof SELECTION_TOOL_ERROR_CODES)[number];

export class SelectionToolError extends Error {
  code: SelectionToolErrorCode;

  constructor(code: SelectionToolErrorCode, message: string) {
    super(message);
    this.name = "SelectionToolError";
    this.code = code;
  }
}

export interface SelectAddArgs {
  path: string;
  mode: SelectionMode;
  slices?: SliceRange[];
  priority?: SelectionPriority;
  rationale?: string;
}

export interface SelectRemoveArgs {
  path: string;
}

export interface SelectGetArgs {
  view?: SelectionView;
}

export interface SelectionToolsContext {
  repoRoot: string;
  repoFiles: readonly string[];
  selectionManager: SelectionManager;
  fileMetadataByPath?: Record<string, { size?: number; isBinary?: boolean }>;
  codemapLookup?: (paths: readonly string[]) => unknown;
  charsPerToken?: number;
}

export interface SelectionValidationResultOk {
  ok: true;
}

export interface SelectionValidationResultErr {
  ok: false;
  message: string;
}

export type SelectionValidationResult =
  | SelectionValidationResultOk
  | SelectionValidationResultErr;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readSelectionPriority(value: unknown): SelectionPriority | null {
  if (
    typeof value === "string" &&
    SELECTION_PRIORITIES.includes(value as SelectionPriority)
  ) {
    return value as SelectionPriority;
  }
  return null;
}

function normalizeSelectionPath(pathValue: string, repoRoot: string): string {
  const resolvedRoot = resolve(repoRoot);
  const normalized = normalizePath(pathValue, resolvedRoot);
  const absolute = toAbsolute(normalized, resolvedRoot);

  if (!isSubpath(absolute, resolvedRoot)) {
    throw new SelectionToolError(
      "INVALID_ARGS",
      "args.path must be within the repository root",
    );
  }

  return normalized;
}

function estimateTokensForEntry(
  entry: ManagedSelectionEntry,
  context: SelectionToolsContext,
): number {
  const charsPerToken = context.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new SelectionToolError(
      "INVALID_ARGS",
      "charsPerToken must be a finite number greater than zero",
    );
  }

  const metadata = context.fileMetadataByPath?.[entry.path];
  const fileSize = metadata?.size;

  if (entry.mode === "full") {
    if (typeof fileSize === "number" && fileSize >= 0) {
      return Math.ceil(fileSize / charsPerToken);
    }
    return 0;
  }

  if (entry.mode === "codemap_only") {
    return DEFAULT_CODEMAP_ONLY_TOKENS;
  }

  let sliceChars = 0;
  for (const slice of entry.slices) {
    const lineCount = Math.max(1, slice.endLine - slice.startLine + 1);
    sliceChars += lineCount * DEFAULT_SLICE_CHARS_PER_LINE;
  }
  return Math.ceil(sliceChars / charsPerToken);
}

function mapSelectionEntry(entry: ManagedSelectionEntry): Record<string, unknown> {
  return {
    path: entry.path,
    mode: entry.mode,
    priority: entry.priority,
    rationale: entry.rationale,
    priority_score: entry.priorityScore,
    slices:
      entry.mode === "slices"
        ? entry.slices.map((slice) => ({
            start_line: slice.startLine,
            end_line: slice.endLine,
            description: slice.description,
            rationale: slice.rationale,
          }))
        : undefined,
  };
}

function ensureRepoFileExists(
  pathValue: string,
  repoFiles: readonly string[],
): void {
  const fileSet = new Set(repoFiles);
  if (!fileSet.has(pathValue)) {
    throw new SelectionToolError(
      "NOT_FOUND",
      `Path is not present in scanned repository files: ${pathValue}`,
    );
  }
}

export function validateSelectAddArgs(args: unknown): SelectionValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return { ok: false, message: "args.path must be a non-empty string" };
  }

  if (
    typeof args.mode !== "string" ||
    !SELECTION_MODES.includes(args.mode as SelectionMode)
  ) {
    return {
      ok: false,
      message: "args.mode must be one of: full, slices, codemap_only",
    };
  }

  if (args.priority !== undefined && readSelectionPriority(args.priority) === null) {
    return {
      ok: false,
      message: "args.priority must be one of: core, support, ref",
    };
  }

  if (args.rationale !== undefined && (typeof args.rationale !== "string" || args.rationale.trim().length === 0)) {
    return { ok: false, message: "args.rationale must be a non-empty string when provided" };
  }

  if (args.mode === "slices") {
    if (!Array.isArray(args.slices) || args.slices.length === 0) {
      return {
        ok: false,
        message: "args.slices must be a non-empty array when args.mode='slices'",
      };
    }

    for (const slice of args.slices) {
      if (!isRecord(slice)) {
        return { ok: false, message: "args.slices entries must be objects" };
      }
      if (
        readPositiveInteger(slice.startLine) === null ||
        readPositiveInteger(slice.endLine) === null
      ) {
        return {
          ok: false,
          message: "args.slices entries require positive integer startLine/endLine",
        };
      }
      if (
        typeof slice.description !== "string" ||
        slice.description.trim().length === 0 ||
        typeof slice.rationale !== "string" ||
        slice.rationale.trim().length === 0
      ) {
        return {
          ok: false,
          message: "args.slices entries require non-empty description and rationale",
        };
      }
    }
  }

  return { ok: true };
}

export function validateSelectRemoveArgs(args: unknown): SelectionValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }
  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return { ok: false, message: "args.path must be a non-empty string" };
  }
  return { ok: true };
}

export function validateSelectGetArgs(args: unknown): SelectionValidationResult {
  if (args === undefined) {
    return { ok: true };
  }
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object when provided" };
  }

  if (
    args.view !== undefined &&
    (typeof args.view !== "string" ||
      !SELECT_GET_VIEWS.includes(args.view as SelectionView))
  ) {
    return {
      ok: false,
      message: "args.view must be one of: summary, files, content, codemaps",
    };
  }
  return { ok: true };
}

export function executeSelectAdd(
  args: SelectAddArgs,
  context: SelectionToolsContext,
): {
  added: string;
  entry: Record<string, unknown>;
} {
  const normalizedPath = normalizeSelectionPath(args.path, context.repoRoot);
  ensureRepoFileExists(normalizedPath, context.repoFiles);

  const priority = args.priority ?? "support";
  const rationale = args.rationale?.trim() ?? "selected by select_add";
  const metadata = context.fileMetadataByPath?.[normalizedPath];

  const addOptions: SelectionAddOptions = {
    isBinary: metadata?.isBinary,
    fileBytes: metadata?.size,
  };

  const addResult = context.selectionManager.add(
    {
      path: normalizedPath,
      mode: args.mode,
      slices: args.mode === "slices" ? args.slices : undefined,
      priority,
      rationale,
    },
    addOptions,
  );

  if (!addResult.ok) {
    throw new SelectionToolError(addResult.error.code, addResult.error.message);
  }

  return {
    added: normalizedPath,
    entry: mapSelectionEntry(addResult.entry),
  };
}

export function executeSelectRemove(
  args: SelectRemoveArgs,
  context: SelectionToolsContext,
): { removed: string } {
  const normalizedPath = normalizeSelectionPath(args.path, context.repoRoot);
  const removed = context.selectionManager.remove(normalizedPath);
  if (!removed) {
    throw new SelectionToolError("NOT_FOUND", `Selection does not include: ${normalizedPath}`);
  }
  return {
    removed: normalizedPath,
  };
}

export function executeSelectGet(
  args: SelectGetArgs | undefined,
  context: SelectionToolsContext,
): Record<string, unknown> {
  const view = args?.view ?? "summary";
  const entries = context.selectionManager.getAll();

  if (view === "files") {
    return {
      view,
      files: entries.map((entry) => mapSelectionEntry(entry)),
    };
  }

  if (view === "content") {
    const files = entries.map((entry) => ({
      ...mapSelectionEntry(entry),
      estimated_tokens: estimateTokensForEntry(entry, context),
    }));

    const totalEstimatedTokens = files.reduce((sum, entry) => {
      const value = entry.estimated_tokens;
      return typeof value === "number" ? sum + value : sum;
    }, 0);

    return {
      view,
      total_estimated_tokens: totalEstimatedTokens,
      files,
    };
  }

  if (view === "codemaps") {
    const codemapPaths = entries
      .filter((entry) => entry.mode === "codemap_only")
      .map((entry) => entry.path);

    return {
      view,
      paths: codemapPaths,
      codemaps: context.codemapLookup ? context.codemapLookup(codemapPaths) : [],
    };
  }

  const summary = context.selectionManager.toSummary();
  const totalEstimatedTokens = entries.reduce(
    (sum, entry) => sum + estimateTokensForEntry(entry, context),
    0,
  );

  return {
    view: "summary",
    total_files: summary.totalFiles,
    total_estimated_tokens: totalEstimatedTokens,
    by_mode: summary.byMode,
    by_priority: summary.byPriority,
  };
}

export function executeSelectClear(
  context: SelectionToolsContext,
): {
  cleared: number;
} {
  const cleared = context.selectionManager.getAll().length;
  context.selectionManager.clear();
  return {
    cleared,
  };
}
