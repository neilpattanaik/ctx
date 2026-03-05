import { matchGlob } from "../utils/paths";

export interface FileSizeLimitOptions {
  maxFileBytes: number;
  includeGlobs?: readonly string[];
  matchGlobImpl?: (pathValue: string, pattern: string) => boolean;
}

export interface FileSizeDecision {
  allowFullRead: boolean;
  exceedsLimit: boolean;
  bypassedByInclude: boolean;
  reason?: "exceeds max_file_bytes";
}

export interface SizedFile {
  path: string;
  size: number;
}

export interface OversizedFileRecord {
  path: string;
  size: number;
  reason: "exceeds max_file_bytes";
}

export interface FileSizePartition<T extends SizedFile> {
  allowed: T[];
  excluded: OversizedFileRecord[];
}

function normalizeMaxFileBytes(maxFileBytes: number): number {
  if (!Number.isFinite(maxFileBytes) || maxFileBytes < 0) {
    throw new Error("maxFileBytes must be a finite number greater than or equal to 0");
  }

  return Math.floor(maxFileBytes);
}

function matchesIncludeGlobs(
  pathValue: string,
  includeGlobs: readonly string[],
  matchGlobImpl: (pathValue: string, pattern: string) => boolean,
): boolean {
  for (const pattern of includeGlobs) {
    if (matchGlobImpl(pathValue, pattern)) {
      return true;
    }
  }
  return false;
}

export function evaluateFileSizeLimit(
  pathValue: string,
  size: number,
  options: FileSizeLimitOptions,
): FileSizeDecision {
  const maxFileBytes = normalizeMaxFileBytes(options.maxFileBytes);
  const includeGlobs = options.includeGlobs ?? [];
  const matcher = options.matchGlobImpl ?? matchGlob;

  if (size <= maxFileBytes) {
    return {
      allowFullRead: true,
      exceedsLimit: false,
      bypassedByInclude: false,
    };
  }

  if (matchesIncludeGlobs(pathValue, includeGlobs, matcher)) {
    return {
      allowFullRead: true,
      exceedsLimit: true,
      bypassedByInclude: true,
    };
  }

  return {
    allowFullRead: false,
    exceedsLimit: true,
    bypassedByInclude: false,
    reason: "exceeds max_file_bytes",
  };
}

export function partitionFilesBySize<T extends SizedFile>(
  files: readonly T[],
  options: FileSizeLimitOptions,
): FileSizePartition<T> {
  const allowed: T[] = [];
  const excluded: OversizedFileRecord[] = [];

  for (const file of files) {
    const decision = evaluateFileSizeLimit(file.path, file.size, options);
    if (decision.allowFullRead) {
      allowed.push(file);
    } else {
      excluded.push({
        path: file.path,
        size: file.size,
        reason: "exceeds max_file_bytes",
      });
    }
  }

  return { allowed, excluded };
}
