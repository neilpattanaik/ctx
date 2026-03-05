import {
  collectGitStatus,
  executeDiffMode,
  type ExecuteDiffOptions,
  type GitDiffFile,
  type GitDiffHunk,
  type GitDiffMode,
  type GitStatusSummary,
} from "../git";

export const GIT_DIFF_DETAILS = ["summary", "patches", "full"] as const;
export const GIT_DIFF_SCOPES = ["all", "selected"] as const;

export type GitDiffDetail = (typeof GIT_DIFF_DETAILS)[number];
export type GitDiffScope = (typeof GIT_DIFF_SCOPES)[number];

export const GIT_TOOL_ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_ARGS",
  "INTERNAL_ERROR",
] as const;

export type GitToolErrorCode = (typeof GIT_TOOL_ERROR_CODES)[number];

export class GitToolError extends Error {
  code: GitToolErrorCode;

  constructor(code: GitToolErrorCode, message: string) {
    super(message);
    this.name = "GitToolError";
    this.code = code;
  }
}

export interface GitToolsContext {
  cwd: string;
  defaultDiffMode?: GitDiffMode;
  selectedPaths?: readonly string[];
  gitMaxFiles?: number;
  gitMaxPatchTokens?: number;
  collectGitStatusImpl?: typeof collectGitStatus;
  executeDiffModeImpl?: typeof executeDiffMode;
}

export interface GitDiffArgs {
  compare?: GitDiffMode;
  detail?: GitDiffDetail;
  scope?: GitDiffScope;
  max_files?: number;
}

export interface GitToolValidationResultOk {
  ok: true;
}

export interface GitToolValidationResultErr {
  ok: false;
  message: string;
}

export type GitToolValidationResult =
  | GitToolValidationResultOk
  | GitToolValidationResultErr;

export interface GitStatusToolResult {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: Array<{
    path: string;
    status: GitStatusSummary["changes"][number]["status"];
  }>;
}

export interface GitDiffStats {
  additions: number;
  deletions: number;
}

export interface GitDiffToolFileSummary {
  path: string;
  status: GitDiffFile["status"];
  stats: GitDiffStats;
}

export interface GitDiffToolFilePatches extends GitDiffToolFileSummary {
  hunks: GitDiffHunk[];
}

export interface GitDiffToolFileFull extends GitDiffToolFilePatches {
  old_path?: string;
  mode_changed: boolean;
  is_binary: boolean;
}

export interface GitDiffToolResult {
  compare: GitDiffMode;
  detail: GitDiffDetail;
  scope: GitDiffScope;
  files: Array<GitDiffToolFileSummary | GitDiffToolFilePatches | GitDiffToolFileFull>;
  capping?: NonNullable<ReturnType<typeof executeDiffMode>["capping"]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function parseDiffDetail(value: unknown): GitDiffDetail {
  if (value === undefined) {
    return "summary";
  }
  if (typeof value !== "string" || !GIT_DIFF_DETAILS.includes(value as GitDiffDetail)) {
    throw new GitToolError(
      "INVALID_ARGS",
      "args.detail must be one of: summary, patches, full",
    );
  }
  return value as GitDiffDetail;
}

function parseDiffScope(value: unknown): GitDiffScope {
  if (value === undefined) {
    return "all";
  }
  if (typeof value !== "string" || !GIT_DIFF_SCOPES.includes(value as GitDiffScope)) {
    throw new GitToolError(
      "INVALID_ARGS",
      "args.scope must be one of: all, selected",
    );
  }
  return value as GitDiffScope;
}

function parseDiffCompare(value: unknown, defaultMode: GitDiffMode): GitDiffMode {
  if (value === undefined) {
    return defaultMode;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitToolError("INVALID_ARGS", "args.compare must be a non-empty string");
  }
  return value as GitDiffMode;
}

function sortDiffFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return files.slice().sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeFileStats(file: GitDiffFile): GitDiffStats {
  let additions = 0;
  let deletions = 0;

  for (const hunk of file.hunks) {
    const lines = hunk.content.split("\n");
    for (const line of lines) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        continue;
      }
      if (line.startsWith("+")) {
        additions += 1;
        continue;
      }
      if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}

function toSummaryFile(file: GitDiffFile): GitDiffToolFileSummary {
  return {
    path: file.path,
    status: file.status,
    stats: summarizeFileStats(file),
  };
}

function toPatchFile(file: GitDiffFile): GitDiffToolFilePatches {
  return {
    ...toSummaryFile(file),
    hunks: file.hunks.map((hunk) => ({ ...hunk })),
  };
}

function toFullFile(file: GitDiffFile): GitDiffToolFileFull {
  return {
    ...toPatchFile(file),
    old_path: file.oldPath,
    mode_changed: file.modeChanged,
    is_binary: file.isBinary,
  };
}

function filterByScope(files: readonly GitDiffFile[], scope: GitDiffScope, selectedPaths: readonly string[]): GitDiffFile[] {
  if (scope !== "selected") {
    return files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({ ...hunk })),
    }));
  }

  if (selectedPaths.length === 0) {
    return [];
  }

  const selected = new Set(selectedPaths);
  return files
    .filter((file) => selected.has(file.path))
    .map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({ ...hunk })),
    }));
}

export function validateGitDiffArgs(args: unknown): GitToolValidationResult {
  if (args === undefined) {
    return { ok: true };
  }
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object when provided" };
  }

  if (
    args.compare !== undefined &&
    (typeof args.compare !== "string" || args.compare.trim().length === 0)
  ) {
    return { ok: false, message: "args.compare must be a non-empty string" };
  }

  if (
    args.detail !== undefined &&
    (typeof args.detail !== "string" || !GIT_DIFF_DETAILS.includes(args.detail as GitDiffDetail))
  ) {
    return { ok: false, message: "args.detail must be one of: summary, patches, full" };
  }

  if (
    args.scope !== undefined &&
    (typeof args.scope !== "string" || !GIT_DIFF_SCOPES.includes(args.scope as GitDiffScope))
  ) {
    return { ok: false, message: "args.scope must be one of: all, selected" };
  }

  if (args.max_files !== undefined && asPositiveInteger(args.max_files) === null) {
    return { ok: false, message: "args.max_files must be a positive integer" };
  }

  return { ok: true };
}

export async function executeGitStatusTool(
  context: GitToolsContext,
): Promise<GitStatusToolResult> {
  const collectStatus = context.collectGitStatusImpl ?? collectGitStatus;
  const status = collectStatus({
    cwd: context.cwd,
  });

  if (!status) {
    throw new GitToolError("NOT_FOUND", "Not a git repository");
  }

  return {
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changes: status.changes
      .slice()
      .sort((left, right) =>
        left.path === right.path
          ? left.status.localeCompare(right.status)
          : left.path.localeCompare(right.path),
      ),
  };
}

export async function executeGitDiffTool(
  args: GitDiffArgs | undefined,
  context: GitToolsContext,
): Promise<GitDiffToolResult> {
  const detail = parseDiffDetail(args?.detail);
  const scope = parseDiffScope(args?.scope);
  const compare = parseDiffCompare(args?.compare, context.defaultDiffMode ?? "uncommitted");
  const maxFiles = clampPositiveInteger(args?.max_files, context.gitMaxFiles ?? 20);
  const selectedPaths = context.selectedPaths ?? [];

  const executeDiff = context.executeDiffModeImpl ?? executeDiffMode;
  const executeOptions: ExecuteDiffOptions = {
    cwd: context.cwd,
    mode: compare,
    maxFiles,
    maxPatchTokens: context.gitMaxPatchTokens ?? 6000,
    selectedPaths: scope === "selected" ? [...selectedPaths] : undefined,
  };
  const diff = executeDiff(executeOptions);

  if (!diff.ok) {
    throw new GitToolError("NOT_FOUND", diff.stderr || "Unable to produce git diff");
  }

  const scopedFiles = filterByScope(diff.files, scope, selectedPaths);
  const cappedFiles = sortDiffFiles(scopedFiles).slice(0, maxFiles);

  let files: Array<GitDiffToolFileSummary | GitDiffToolFilePatches | GitDiffToolFileFull>;
  if (detail === "summary") {
    files = cappedFiles.map(toSummaryFile);
  } else if (detail === "patches") {
    files = cappedFiles.map(toPatchFile);
  } else {
    files = cappedFiles.map(toFullFile);
  }

  return {
    compare,
    detail,
    scope,
    files,
    capping: diff.capping,
  };
}
