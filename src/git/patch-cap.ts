import type { GitDiffFile } from "./diff";
import {
  estimateTokensFromText,
  type TokenEstimateOptions,
} from "../utils/token-estimate";

export interface PatchTokenCapOptions extends TokenEstimateOptions {
  maxPatchTokens: number;
  maxFiles?: number;
  taskTerms?: readonly string[];
  selectedPaths?: readonly string[];
}

export interface PatchTokenCapResult {
  files: GitDiffFile[];
  usedTokens: number;
  truncated: boolean;
  truncatedFiles: number;
  truncatedTokens: number;
  marker?: string;
}

function cloneGitDiffFile(file: GitDiffFile): GitDiffFile {
  return {
    ...file,
    hunks: file.hunks.map((hunk) => ({ ...hunk })),
  };
}

function renderPatchFile(file: GitDiffFile): string {
  const lines: string[] = [];
  const oldPath = file.oldPath ?? file.path;
  lines.push(`diff --git a/${oldPath} b/${file.path}`);
  lines.push(`status: ${file.status}`);
  if (file.modeChanged) {
    lines.push("mode changed");
  }
  if (file.isBinary) {
    lines.push("Binary files differ");
    return lines.join("\n");
  }

  for (const hunk of file.hunks) {
    lines.push(hunk.content);
  }

  return lines.join("\n");
}

export function estimatePatchFileTokens(
  file: GitDiffFile,
  options?: TokenEstimateOptions,
): number {
  return estimateTokensFromText(renderPatchFile(file), options);
}

function patchRelevanceScore(
  file: GitDiffFile,
  taskTerms: readonly string[],
  selectedPaths: ReadonlySet<string>,
): number {
  let score = 0;
  if (selectedPaths.has(file.path) || (file.oldPath && selectedPaths.has(file.oldPath))) {
    score += 1000;
  }

  const pathText = `${file.path} ${file.oldPath ?? ""}`.toLowerCase();
  for (const term of taskTerms) {
    if (term.length === 0) {
      continue;
    }
    if (pathText.includes(term)) {
      score += 100;
    }
  }

  return score;
}

function sortFilesByRelevance(
  files: readonly GitDiffFile[],
  taskTerms: readonly string[],
  selectedPaths: ReadonlySet<string>,
): GitDiffFile[] {
  return [...files].sort((left, right) => {
    const leftScore = patchRelevanceScore(left, taskTerms, selectedPaths);
    const rightScore = patchRelevanceScore(right, taskTerms, selectedPaths);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    const leftHunkSize = left.hunks.reduce(
      (sum, hunk) => sum + hunk.content.length,
      0,
    );
    const rightHunkSize = right.hunks.reduce(
      (sum, hunk) => sum + hunk.content.length,
      0,
    );
    if (leftHunkSize !== rightHunkSize) {
      return rightHunkSize - leftHunkSize;
    }

    return left.path.localeCompare(right.path);
  });
}

export function formatPatchTruncationMarker(
  truncatedFiles: number,
  truncatedTokens: number,
): string {
  return `... ‹TRUNCATED: ${truncatedFiles} more files, ~${truncatedTokens} tokens›`;
}

export function capPatchFilesByTokens(
  files: readonly GitDiffFile[],
  options: PatchTokenCapOptions,
): PatchTokenCapResult {
  const maxPatchTokens = Math.max(0, options.maxPatchTokens);
  const taskTerms = (options.taskTerms ?? []).map((term) =>
    term.trim().toLowerCase(),
  );
  const selectedPaths = new Set(options.selectedPaths ?? []);
  const normalizedMaxFiles =
    options.maxFiles === undefined
      ? undefined
      : Number.isInteger(options.maxFiles) && options.maxFiles > 0
        ? options.maxFiles
        : undefined;

  const orderedFiles = sortFilesByRelevance(files, taskTerms, selectedPaths);
  const scopedFiles =
    normalizedMaxFiles === undefined
      ? orderedFiles
      : orderedFiles.slice(0, normalizedMaxFiles);
  const includedFiles: GitDiffFile[] = [];
  let usedTokens = 0;
  let truncatedFiles = 0;
  let truncatedTokens = 0;

  if (normalizedMaxFiles !== undefined && orderedFiles.length > normalizedMaxFiles) {
    for (const omittedFile of orderedFiles.slice(normalizedMaxFiles)) {
      truncatedFiles += 1;
      truncatedTokens += estimatePatchFileTokens(omittedFile, options);
    }
  }

  for (let index = 0; index < scopedFiles.length; index += 1) {
    const file = scopedFiles[index]!;
    const fullTokens = estimatePatchFileTokens(file, options);

    if (usedTokens + fullTokens <= maxPatchTokens) {
      includedFiles.push(cloneGitDiffFile(file));
      usedTokens += fullTokens;
      continue;
    }

    let includedCurrentFileTokens = 0;
    if (!file.isBinary && file.hunks.length > 0) {
      const partialHunks = [];
      for (const hunk of file.hunks) {
        partialHunks.push({ ...hunk });
        const partialFile: GitDiffFile = {
          ...file,
          hunks: partialHunks,
        };
        const partialTokens = estimatePatchFileTokens(partialFile, options);
        if (usedTokens + partialTokens <= maxPatchTokens) {
          includedCurrentFileTokens = partialTokens;
          continue;
        }
        partialHunks.pop();
        break;
      }

      if (partialHunks.length > 0) {
        includedFiles.push({
          ...file,
          hunks: partialHunks,
        });
        usedTokens += includedCurrentFileTokens;
        truncatedFiles += 1;
        truncatedTokens += fullTokens - includedCurrentFileTokens;
      } else {
        truncatedFiles += 1;
        truncatedTokens += fullTokens;
      }
    } else {
      truncatedFiles += 1;
      truncatedTokens += fullTokens;
    }

    for (let remainderIndex = index + 1; remainderIndex < scopedFiles.length; remainderIndex += 1) {
      truncatedFiles += 1;
      truncatedTokens += estimatePatchFileTokens(
        scopedFiles[remainderIndex]!,
        options,
      );
    }

    break;
  }

  const truncated = truncatedFiles > 0;

  return {
    files: includedFiles,
    usedTokens,
    truncated,
    truncatedFiles,
    truncatedTokens,
    marker:
      truncated && truncatedFiles > 0
        ? formatPatchTruncationMarker(truncatedFiles, truncatedTokens)
        : undefined,
  };
}
