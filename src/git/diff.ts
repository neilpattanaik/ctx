import { capPatchFilesByTokens, estimatePatchFileTokens } from "./patch-cap";
import type { GitCommandResult } from "./runner";
import { runGitCommand } from "./runner";

const DEFAULT_MAX_PATCH_TOKENS = 6000;

export type GitDiffMode =
  | "off"
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "main"
  | `compare:${string}`
  | `back:${number}`
  | string;

export type GitDiffStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unmerged"
  | "unknown";

export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  content: string;
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: GitDiffStatus;
  modeChanged: boolean;
  isBinary: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffResult {
  ok: boolean;
  mode: GitDiffMode;
  files: GitDiffFile[];
  stderr: string;
  failureKind?: GitCommandResult["failureKind"];
  capping?: GitDiffCapping;
  truncationNotice?: string;
  truncatedFileCount?: number;
  truncatedTokenEstimate?: number;
}

export interface GitDiffCapping {
  applied: boolean;
  maxPatchTokens: number;
  usedPatchTokens: number;
  omittedFiles: number;
  omittedTokensApprox: number;
  marker?: string;
}

export interface ExecuteDiffOptions {
  cwd: string;
  mode: GitDiffMode;
  maxFiles: number;
  maxPatchTokens?: number;
  selectedPaths?: string[];
  taskTerms?: string[];
  relevancePaths?: string[];
  relevanceTerms?: string[];
  runGitCommandImpl?: typeof runGitCommand;
}

interface DiffCommandPlan {
  enabled: boolean;
  args: string[];
}

interface MutableDiffFile {
  path: string;
  oldPath?: string;
  status: GitDiffStatus;
  modeChanged: boolean;
  isBinary: boolean;
  hunks: GitDiffHunk[];
}

const HUNK_HEADER_PATTERN =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function normalizePath(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

export function estimatePatchTokens(files: readonly GitDiffFile[]): number {
  return files.reduce(
    (sum, file) => sum + estimatePatchFileTokens(file),
    0,
  );
}

export function applyPatchTokenCap(options: {
  files: GitDiffFile[];
  maxFiles?: number;
  maxPatchTokens: number;
  relevancePaths?: string[];
  relevanceTerms?: string[];
}): { files: GitDiffFile[]; capping: GitDiffCapping } {
  const normalizedMaxPatchTokens = Math.floor(Math.max(options.maxPatchTokens, 0));
  const capped = capPatchFilesByTokens(options.files, {
    maxPatchTokens: normalizedMaxPatchTokens,
    maxFiles: options.maxFiles,
    selectedPaths: options.relevancePaths,
    taskTerms: options.relevanceTerms,
  });

  if (!capped.truncated) {
    return {
      files: options.files.map((file) => ({
        ...file,
        hunks: file.hunks.map((hunk) => ({ ...hunk })),
      })),
      capping: {
        applied: false,
        maxPatchTokens: normalizedMaxPatchTokens,
        usedPatchTokens: estimatePatchTokens(options.files),
        omittedFiles: 0,
        omittedTokensApprox: 0,
        marker: undefined,
      },
    };
  }

  return {
    files: capped.files,
    capping: {
      applied: true,
      maxPatchTokens: normalizedMaxPatchTokens,
      usedPatchTokens: capped.usedTokens,
      omittedFiles: capped.truncatedFiles,
      omittedTokensApprox: capped.truncatedTokens,
      marker: capped.marker,
    },
  };
}

export function resolveDiffCommand(mode: GitDiffMode): DiffCommandPlan {
  if (mode === "off") {
    return { enabled: false, args: [] };
  }

  if (mode === "uncommitted") {
    return { enabled: true, args: ["diff", "HEAD"] };
  }
  if (mode === "staged") {
    return { enabled: true, args: ["diff", "--cached"] };
  }
  if (mode === "unstaged") {
    return { enabled: true, args: ["diff"] };
  }
  if (mode === "main") {
    return { enabled: true, args: ["diff", "main...HEAD"] };
  }
  if (mode.startsWith("compare:")) {
    const compareSpec = mode.slice("compare:".length).trim();
    return {
      enabled: true,
      args: ["diff", compareSpec.length > 0 ? compareSpec : "HEAD"],
    };
  }
  if (mode.startsWith("back:")) {
    const rawValue = mode.slice("back:".length).trim();
    const count = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid back diff mode: ${mode}`);
    }
    return { enabled: true, args: ["diff", `HEAD~${count}`] };
  }

  return { enabled: true, args: ["diff", `${mode}...HEAD`] };
}

function finalizeFile(
  files: MutableDiffFile[],
  currentFile: MutableDiffFile | null,
  hunkLines: string[],
): void {
  if (!currentFile) {
    return;
  }

  if (hunkLines.length > 0 && currentFile.hunks.length > 0) {
    currentFile.hunks[currentFile.hunks.length - 1]!.content = hunkLines.join("\n");
    hunkLines.length = 0;
  }

  files.push(currentFile);
}

export function parseUnifiedDiff(output: string): GitDiffFile[] {
  const files: MutableDiffFile[] = [];
  let currentFile: MutableDiffFile | null = null;
  let currentHunkLines: string[] = [];

  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finalizeFile(files, currentFile, currentHunkLines);

      const [, rawOldPath = "", rawNewPath = ""] = line.split(" ");
      currentFile = {
        oldPath: normalizePath(rawOldPath),
        path: normalizePath(rawNewPath),
        status: "modified",
        modeChanged: false,
        isBinary: false,
        hunks: [],
      };
      currentHunkLines = [];
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      continue;
    }
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      currentFile.modeChanged = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.path = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("copy from ")) {
      currentFile.status = "copied";
      currentFile.oldPath = line.slice("copy from ".length);
      continue;
    }
    if (line.startsWith("copy to ")) {
      currentFile.status = "copied";
      currentFile.path = line.slice("copy to ".length);
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      currentFile.isBinary = true;
      continue;
    }
    if (line.startsWith("index ")) {
      continue;
    }

    const hunkHeaderMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkHeaderMatch) {
      if (currentHunkLines.length > 0 && currentFile.hunks.length > 0) {
        currentFile.hunks[currentFile.hunks.length - 1]!.content =
          currentHunkLines.join("\n");
      }
      currentHunkLines = [];

      currentFile.hunks.push({
        oldStart: Number.parseInt(hunkHeaderMatch[1]!, 10),
        oldCount: Number.parseInt(hunkHeaderMatch[2] ?? "1", 10),
        newStart: Number.parseInt(hunkHeaderMatch[3]!, 10),
        newCount: Number.parseInt(hunkHeaderMatch[4] ?? "1", 10),
        content: "",
      });
      currentHunkLines.push(line);
      continue;
    }

    if (currentFile.hunks.length > 0) {
      currentHunkLines.push(line);
    }
  }

  finalizeFile(files, currentFile, currentHunkLines);

  return files.map((file) => ({
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    modeChanged: file.modeChanged,
    isBinary: file.isBinary,
    hunks: file.hunks.map((hunk) => ({ ...hunk })),
  }));
}

export function executeDiffMode(options: ExecuteDiffOptions): GitDiffResult {
  const plan = resolveDiffCommand(options.mode);
  if (!plan.enabled) {
    return {
      ok: true,
      mode: options.mode,
      files: [],
      stderr: "",
    };
  }

  const runGit = options.runGitCommandImpl ?? runGitCommand;
  const commandResult = runGit({
    cwd: options.cwd,
    args: plan.args,
  });

  if (!commandResult.ok) {
    return {
      ok: false,
      mode: options.mode,
      files: [],
      stderr: commandResult.stderr,
      failureKind: commandResult.failureKind,
    };
  }

  const parsedFiles = parseUnifiedDiff(commandResult.stdout);
  const maxPatchTokens = options.maxPatchTokens ?? DEFAULT_MAX_PATCH_TOKENS;

  const capped = applyPatchTokenCap({
    files: parsedFiles,
    maxFiles: options.maxFiles,
    maxPatchTokens,
    relevancePaths: options.selectedPaths,
    relevanceTerms: options.taskTerms,
  });

  return {
    ok: true,
    mode: options.mode,
    files: capped.files,
    stderr: commandResult.stderr,
    capping: capped.capping,
    truncationNotice: capped.capping.marker,
    truncatedFileCount: capped.capping.omittedFiles,
    truncatedTokenEstimate: capped.capping.omittedTokensApprox,
  };
}
