import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const GIT_SAFETY_FLAGS = ["--no-ext-diff", "--no-textconv", "--color=never"];

export type GitFailureKind =
  | "NOT_GIT_REPO"
  | "NO_COMMITS"
  | "PERMISSION_DENIED"
  | "TIMEOUT"
  | "SPAWN_ERROR"
  | "OTHER";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  failureKind?: GitFailureKind;
}

export interface RunGitCommandOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  spawnSyncImpl?: typeof spawnSync;
}

function classifyFailure(result: {
  timedOut: boolean;
  stderr: string;
  spawnErrorCode?: string;
}): GitFailureKind {
  if (result.timedOut) {
    return "TIMEOUT";
  }

  if (result.spawnErrorCode) {
    return "SPAWN_ERROR";
  }

  const lowerStderr = result.stderr.toLowerCase();

  if (lowerStderr.includes("not a git repository")) {
    return "NOT_GIT_REPO";
  }
  if (
    lowerStderr.includes("does not have any commits yet") ||
    lowerStderr.includes("unknown revision or path not in the working tree")
  ) {
    return "NO_COMMITS";
  }
  if (lowerStderr.includes("permission denied")) {
    return "PERMISSION_DENIED";
  }
  return "OTHER";
}

export function runGitCommand(options: RunGitCommandOptions): GitCommandResult {
  const spawnImpl = options.spawnSyncImpl ?? spawnSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const commandArgs = [...GIT_SAFETY_FLAGS, ...options.args];
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  };

  const result = spawnImpl("git", commandArgs, spawnOptions);

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const spawnErrorCode =
    result.error && typeof result.error === "object" && "code" in result.error
      ? String(result.error.code ?? "")
      : undefined;
  const timedOut = spawnErrorCode === "ETIMEDOUT";

  const exitCode =
    typeof result.status === "number" ? result.status : timedOut ? 124 : 1;
  const ok = exitCode === 0;

  return {
    ok,
    stdout,
    stderr,
    exitCode,
    timedOut,
    failureKind: ok
      ? undefined
      : classifyFailure({
          timedOut,
          stderr,
          spawnErrorCode: spawnErrorCode || undefined,
        }),
  };
}
