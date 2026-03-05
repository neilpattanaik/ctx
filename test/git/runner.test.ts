import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { runGitCommand } from "../../src/git/runner";

function makeSpawnResult(overrides: Record<string, unknown>) {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

describe("runGitCommand", () => {
  test("enforces non-interactive env and global color settings", () => {
    const calls: Array<{
      command: string;
      args: string[];
      envPrompt: string | undefined;
    }> = [];

    const fakeSpawn = ((command, args, options) => {
      calls.push({
        command,
        args: args as string[],
        envPrompt:
          options && "env" in options
            ? (options.env as Record<string, string | undefined> | undefined)
                ?.GIT_TERMINAL_PROMPT
            : undefined,
      });
      return makeSpawnResult({});
    }) as unknown as typeof spawnSync;

    runGitCommand({
      cwd: process.cwd(),
      args: ["status", "--short"],
      spawnSyncImpl: fakeSpawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toEqual([
      "-c",
      "color.ui=never",
      "status",
      "--short",
    ]);
    expect(calls[0]?.envPrompt).toBe("0");
  });

  test("applies diff safety flags to diff commands", () => {
    const calls: string[][] = [];

    const fakeSpawn = ((_, args) => {
      calls.push(args as string[]);
      return makeSpawnResult({});
    }) as unknown as typeof spawnSync;

    runGitCommand({
      cwd: process.cwd(),
      args: ["diff", "HEAD~1"],
      spawnSyncImpl: fakeSpawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "-c",
      "color.ui=never",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--color=never",
      "HEAD~1",
    ]);
  });

  test("classifies timeout failures", () => {
    const fakeSpawn = (() =>
      makeSpawnResult({
        stdout: "",
        stderr: "",
        status: null,
        error: { code: "ETIMEDOUT" },
      })) as unknown as typeof spawnSync;

    const result = runGitCommand({
      cwd: process.cwd(),
      args: ["status"],
      timeoutMs: 1,
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.failureKind).toBe("TIMEOUT");
  });
});
