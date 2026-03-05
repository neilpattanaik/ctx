import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { runGitCommand } from "../../src/git";
import { collectGitStatus, parseGitStatusPorcelainV2 } from "../../src/git";

const PORCELAIN_SAMPLE = [
  "# branch.oid 1234567890abcdef",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 M. N... 100644 100644 100644 abcdef1 abcdef2 src/changed.ts",
  "1 A. N... 100644 100644 100644 abcdef1 abcdef2 src/added.ts",
  "1 D. N... 100644 100644 100644 abcdef1 abcdef2 src/deleted.ts",
  "2 R. N... 100644 100644 100644 abcdef1 abcdef2 R100 src/new-name.ts\tsrc/old-name.ts",
  "? src/untracked.ts",
  "u UU N... 100644 100644 100644 100644 abcdef1 abcdef2 abcdef3 src/conflict.ts",
].join("\n");

describe("parseGitStatusPorcelainV2", () => {
  test("parses branch, ahead/behind, and file changes", () => {
    const parsed = parseGitStatusPorcelainV2(PORCELAIN_SAMPLE);

    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.changes).toEqual([
      { path: "src/changed.ts", status: "modified" },
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/new-name.ts", status: "renamed" },
      { path: "src/untracked.ts", status: "untracked" },
      { path: "src/conflict.ts", status: "unmerged" },
    ]);
  });

  test("marks detached head branch explicitly", () => {
    const parsed = parseGitStatusPorcelainV2([
      "# branch.oid deadbeef",
      "# branch.head (detached)",
    ].join("\n"));

    expect(parsed.branch).toBe("HEAD (detached)");
  });
});

describe("collectGitStatus", () => {
  test("returns parsed status on successful git command", () => {
    const fakeRunGit = ((options) => {
      expect(options.args).toEqual(["status", "--porcelain=v2", "--branch"]);
      return {
        ok: true,
        stdout: PORCELAIN_SAMPLE,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    }) as unknown as typeof runGitCommand;

    const status = collectGitStatus({
      cwd: process.cwd(),
      runGitCommandImpl: fakeRunGit,
    });

    expect(status).not.toBeNull();
    expect(status?.branch).toBe("main");
    expect(status?.changes).toHaveLength(6);
  });

  test("returns null for non-git directories", () => {
    const fakeRunGit = (() => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
      failureKind: "NOT_GIT_REPO" as const,
    })) as unknown as typeof runGitCommand;

    const status = collectGitStatus({
      cwd: process.cwd(),
      runGitCommandImpl: fakeRunGit,
    });

    expect(status).toBeNull();
  });

  test("returns empty baseline for no-commit repositories", () => {
    const fakeRunGit = (() => ({
      ok: false,
      stdout: "",
      stderr: "fatal: your current branch does not have any commits yet",
      exitCode: 128,
      timedOut: false,
      failureKind: "NO_COMMITS" as const,
    })) as unknown as typeof runGitCommand;

    const status = collectGitStatus({
      cwd: process.cwd(),
      runGitCommandImpl: fakeRunGit,
    });

    expect(status).toEqual({
      branch: "HEAD (no commits)",
      ahead: 0,
      behind: 0,
      changes: [],
    });
  });
});

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${repoRoot}: ${result.stderr ?? "unknown error"}`,
    );
  }

  return result.stdout ?? "";
}

function writeTextFile(repoRoot: string, relativePath: string, content: string): void {
  const fullPath = join(repoRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function createRepo(initialFiles: Record<string, string>): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "ctx-git-status-integration-"));
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["branch", "-M", "main"]);
  runGit(repoRoot, ["config", "user.name", "ctx-tests"]);
  runGit(repoRoot, ["config", "user.email", "ctx-tests@example.com"]);

  for (const [path, content] of Object.entries(initialFiles)) {
    writeTextFile(repoRoot, path, content);
  }

  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

describe("collectGitStatus integration", () => {
  test("parses real git status output from an active repository", () => {
    const repoRoot = createRepo({
      "src/changed.ts": "export const changed = 1;\n",
    });

    writeTextFile(repoRoot, "src/changed.ts", "export const changed = 2;\n");
    writeTextFile(repoRoot, "src/untracked.ts", "export const untracked = true;\n");

    const status = collectGitStatus({
      cwd: repoRoot,
    });

    expect(status).not.toBeNull();
    expect(status?.branch).toBe("main");
    expect(status?.changes).toEqual(
      expect.arrayContaining([
        { path: "src/changed.ts", status: "modified" },
        { path: "src/untracked.ts", status: "untracked" },
      ]),
    );
  });

  test("returns null for real non-git directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-git-status-not-repo-"));

    const status = collectGitStatus({
      cwd: tempDir,
    });

    expect(status).toBeNull();
  });
});
