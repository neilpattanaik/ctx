import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_NOT_FOUND_EXIT_CODE = 3;

export class RepoRootError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = REPO_NOT_FOUND_EXIT_CODE) {
    super(message);
    this.name = "RepoRootError";
    this.exitCode = exitCode;
  }
}

export interface DetectRepoRootOptions {
  repoFlag?: string;
  cwd?: string;
  resolveGitRoot?: (cwd: string) => string | null;
}

function resolveExistingDirectory(pathValue: string): string {
  const absolutePath = resolve(pathValue);
  const realPath = realpathSync(absolutePath);
  const stats = statSync(realPath);

  if (!stats.isDirectory()) {
    throw new RepoRootError(`Repository path is not a directory: ${pathValue}`);
  }

  accessSync(realPath, constants.R_OK);
  return realPath;
}

function defaultResolveGitRoot(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function detectRepoRoot(options?: DetectRepoRootOptions): string {
  const cwd = options?.cwd ? resolve(options.cwd) : process.cwd();

  if (options?.repoFlag) {
    try {
      return resolveExistingDirectory(options.repoFlag);
    } catch {
      throw new RepoRootError(`Repository not found: ${options.repoFlag}`);
    }
  }

  const gitRootResolver = options?.resolveGitRoot ?? defaultResolveGitRoot;
  const gitRoot = gitRootResolver(cwd);

  if (gitRoot) {
    try {
      return resolveExistingDirectory(gitRoot);
    } catch {
      // Fall through to cwd when git root is stale or inaccessible.
    }
  }

  try {
    return resolveExistingDirectory(cwd);
  } catch {
    throw new RepoRootError(`Repository not found: ${cwd}`);
  }
}
