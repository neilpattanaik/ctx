import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runGitCommand } from "../../src/git/runner";

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
  const repoRoot = mkdtempSync(join(tmpdir(), "ctx-git-runner-integration-"));
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

describe("runGitCommand integration", () => {
  test("returns successful status output for real repositories", () => {
    const repoRoot = createRepo({
      "src/app.ts": "export const value = 1;\n",
    });

    writeTextFile(repoRoot, "src/app.ts", "export const value = 2;\n");

    const result = runGitCommand({
      cwd: repoRoot,
      args: ["status", "--short"],
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/app.ts");
    expect(result.failureKind).toBeUndefined();
  });

  test("classifies non-repository directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-git-runner-not-repo-"));

    const result = runGitCommand({
      cwd: tempDir,
      args: ["status"],
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("NOT_GIT_REPO");
    expect(result.exitCode).toBeGreaterThan(0);
  });

  test("classifies no-commit repositories for diff HEAD", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ctx-git-runner-no-commits-"));
    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["branch", "-M", "main"]);
    runGit(repoRoot, ["config", "user.name", "ctx-tests"]);
    runGit(repoRoot, ["config", "user.email", "ctx-tests@example.com"]);
    writeTextFile(repoRoot, "src/app.ts", "export const value = 1;\n");

    const result = runGitCommand({
      cwd: repoRoot,
      args: ["diff", "HEAD"],
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("NO_COMMITS");
    expect(result.exitCode).toBeGreaterThan(0);
  });
});
