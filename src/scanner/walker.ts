import { readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { FileEntry } from "../types/contracts";
import { matchGlob, normalizePath } from "../utils/paths";
import { isBinaryFile } from "./binary-detect";
import {
  createGitignoreMatcher,
  type CreateGitignoreMatcherOptions,
} from "./gitignore";
import {
  evaluateFileSizeLimit,
  type OversizedFileRecord,
} from "./size-limit";

const DEFAULT_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".kt": "kotlin",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const GIT_DIRECTORY_NAME = ".git";

export interface ScanWarning {
  path: string;
  reason: "readdir_failed" | "stat_failed" | "binary_check_failed";
  message: string;
}

export interface WalkRepositoryOptions {
  repoRoot: string;
  maxFileBytes: number;
  useGitignore?: boolean;
  extraIgnorePatterns?: string[];
  includeGlobs?: readonly string[];
  neverIncludeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  skipBinary?: boolean;
  binarySniffBytes?: number;
  resolveGlobalGitignorePath?: CreateGitignoreMatcherOptions["resolveGlobalGitignorePath"];
  onWarning?: (warning: ScanWarning) => void;
  readBinaryChunk?: (pathValue: string, maxBytes: number) => Uint8Array;
}

export interface WalkRepositoryResult {
  files: FileEntry[];
  oversized: OversizedFileRecord[];
  excluded: ExcludedFileRecord[];
  warnings: ScanWarning[];
}

export interface ExcludedFileRecord {
  path: string;
  reason: "binary" | "exceeds max_file_bytes" | "never-include";
  size?: number;
}

function detectLanguage(pathValue: string): string {
  const extension = extname(pathValue).toLowerCase();
  return DEFAULT_LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

function matchesAny(pathValue: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(pathValue, pattern)) {
      return true;
    }
  }
  return false;
}

function sortDirents(dirents: Dirent[]): Dirent[] {
  return dirents.sort((left, right) => left.name.localeCompare(right.name));
}

export async function walkRepositoryFiles(
  options: WalkRepositoryOptions,
): Promise<WalkRepositoryResult> {
  const repoRoot = resolve(options.repoRoot);
  const includeGlobs = options.includeGlobs ?? [];
  const neverIncludeGlobs = options.neverIncludeGlobs ?? [];
  const excludeGlobs = options.excludeGlobs ?? [];
  const skipBinary = options.skipBinary ?? true;

  const matcher = createGitignoreMatcher({
    repoRoot,
    useGitignore: options.useGitignore,
    extraIgnorePatterns: options.extraIgnorePatterns
      ? [...options.extraIgnorePatterns]
      : [],
    resolveGlobalGitignorePath: options.resolveGlobalGitignorePath,
  });

  const warnings: ScanWarning[] = [];
  const files: FileEntry[] = [];
  const oversized: OversizedFileRecord[] = [];
  const excluded: ExcludedFileRecord[] = [];
  const pendingDirectories: string[] = [repoRoot];

  const pushWarning = (warning: ScanWarning): void => {
    warnings.push(warning);
    options.onWarning?.(warning);
  };

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }

    let dirents: Dirent[];
    try {
      dirents = sortDirents(
        await readdir(currentDirectory, {
          withFileTypes: true,
        }),
      );
    } catch (error) {
      const relPath = normalizePath(currentDirectory, repoRoot);
      pushWarning({
        path: relPath,
        reason: "readdir_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const subdirectories: string[] = [];
    for (const dirent of dirents) {
      const absolutePath = resolve(currentDirectory, dirent.name);
      const relativePath = normalizePath(absolutePath, repoRoot);
      if (relativePath === ".") {
        continue;
      }

      if (dirent.isDirectory()) {
        if (dirent.name === GIT_DIRECTORY_NAME) {
          continue;
        }
        if (
          matcher.shouldIgnore(relativePath, true) ||
          matchesAny(relativePath, excludeGlobs)
        ) {
          continue;
        }
        subdirectories.push(absolutePath);
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      if (matcher.shouldIgnore(relativePath, false)) {
        continue;
      }

      if (matchesAny(relativePath, neverIncludeGlobs)) {
        excluded.push({
          path: relativePath,
          reason: "never-include",
        });
        continue;
      }

      if (skipBinary) {
        try {
          const isBinary = isBinaryFile(absolutePath, {
            sniffBytes: options.binarySniffBytes,
            readChunk: options.readBinaryChunk,
          });
          if (isBinary) {
            excluded.push({
              path: relativePath,
              reason: "binary",
            });
            continue;
          }
        } catch (error) {
          pushWarning({
            path: relativePath,
            reason: "binary_check_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      let fileStats;
      try {
        fileStats = await stat(absolutePath);
      } catch (error) {
        pushWarning({
          path: relativePath,
          reason: "stat_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const sizeDecision = evaluateFileSizeLimit(relativePath, fileStats.size, {
        maxFileBytes: options.maxFileBytes,
        includeGlobs,
      });
      if (!sizeDecision.allowFullRead) {
        const oversizedEntry = {
          path: relativePath,
          size: fileStats.size,
          reason: "exceeds max_file_bytes",
        } as const;
        oversized.push(oversizedEntry);
        excluded.push(oversizedEntry);
        continue;
      }

      if (matchesAny(relativePath, excludeGlobs)) {
        continue;
      }

      files.push({
        path: relativePath,
        size: fileStats.size,
        mtime: fileStats.mtimeMs,
        hash: "",
        language: detectLanguage(relativePath),
        isText: true,
      });
    }

    for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(subdirectories[index]);
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  oversized.sort((left, right) => left.path.localeCompare(right.path));
  excluded.sort((left, right) =>
    left.path === right.path
      ? left.reason.localeCompare(right.reason)
      : left.path.localeCompare(right.path),
  );
  warnings.sort((left, right) =>
    left.path === right.path
      ? left.reason.localeCompare(right.reason)
      : left.path.localeCompare(right.path),
  );

  return {
    files,
    oversized,
    excluded,
    warnings,
  };
}
