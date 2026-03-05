import { realpathSync } from "node:fs";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";

const WINDOWS_SEPARATOR = /\\/g;

export type PathDisplayMode = "relative" | "absolute";

function toPosixPath(value: string): string {
  return value.replace(WINDOWS_SEPARATOR, "/");
}

function canonicalPath(pathValue: string): string {
  const absolutePath = resolve(toPosixPath(pathValue));

  try {
    return resolve(realpathSync(absolutePath));
  } catch {
    return absolutePath;
  }
}

export function normalizePath(pathValue: string, repoRoot: string): string {
  const resolvedRoot = resolve(toPosixPath(repoRoot));
  const resolvedPath = isAbsolute(pathValue)
    ? resolve(toPosixPath(pathValue))
    : resolve(resolvedRoot, toPosixPath(pathValue));

  const relPath = relative(resolvedRoot, resolvedPath);
  if (relPath.length === 0) {
    return ".";
  }

  return toPosixPath(relPath);
}

export function toAbsolute(relPath: string, repoRoot: string): string {
  return resolve(toPosixPath(repoRoot), normalizePath(relPath, repoRoot));
}

export function isSubpath(candidate: string, parent: string): boolean {
  const canonicalCandidate = canonicalPath(candidate);
  const canonicalParent = canonicalPath(parent);
  const relPath = relative(canonicalParent, canonicalCandidate);

  return (
    relPath.length === 0 ||
    (!relPath.startsWith("..") && !isAbsolute(relPath))
  );
}

export function pathDisplay(
  pathValue: string,
  mode: PathDisplayMode,
  repoRoot: string,
): string {
  if (mode === "absolute") {
    return toPosixPath(toAbsolute(pathValue, repoRoot));
  }

  return normalizePath(pathValue, repoRoot);
}

export function matchGlob(pathValue: string, pattern: string): boolean {
  return matchesGlob(toPosixPath(pathValue), toPosixPath(pattern));
}
