import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { estimatePatchTokens, executeDiffMode, type GitDiffFile } from "../../src/git";

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

function writeBinaryFile(repoRoot: string, relativePath: string, content: Uint8Array): void {
  const fullPath = join(repoRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function createRepo(initialFiles: Record<string, string>): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "ctx-git-diff-integration-"));
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

function commitAll(repoRoot: string, message: string): void {
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", message]);
}

function findFile(files: readonly GitDiffFile[], path: string): GitDiffFile | undefined {
  return files.find((file) => file.path === path);
}

describe("executeDiffMode integration", () => {
  test("returns uncommitted changes", () => {
    const repoRoot = createRepo({
      "src/app.ts": "export const value = 1;\n",
    });

    writeTextFile(repoRoot, "src/app.ts", "export const value = 2;\n");

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "uncommitted",
      maxFiles: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.files.map((file) => file.path)).toContain("src/app.ts");
  });

  test("returns only staged changes in staged mode", () => {
    const repoRoot = createRepo({
      "src/staged.ts": "export const staged = 1;\n",
      "src/unstaged.ts": "export const unstaged = 1;\n",
    });

    writeTextFile(repoRoot, "src/staged.ts", "export const staged = 2;\n");
    writeTextFile(repoRoot, "src/unstaged.ts", "export const unstaged = 2;\n");
    runGit(repoRoot, ["add", "src/staged.ts"]);

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "staged",
      maxFiles: 20,
    });

    expect(result.ok).toBe(true);
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain("src/staged.ts");
    expect(paths).not.toContain("src/unstaged.ts");
  });

  test("supports compare:main mode from a feature branch", () => {
    const repoRoot = createRepo({
      "src/auth.ts": "export const authVersion = 1;\n",
    });

    runGit(repoRoot, ["checkout", "-b", "feature/login"]);
    writeTextFile(repoRoot, "src/auth.ts", "export const authVersion = 2;\n");
    commitAll(repoRoot, "feature change");

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "compare:main",
      maxFiles: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.files.map((file) => file.path)).toContain("src/auth.ts");
  });

  test("supports back:N mode for recent commit ranges", () => {
    const repoRoot = createRepo({
      "src/counter.ts": "export const counter = 0;\n",
    });

    writeTextFile(repoRoot, "src/counter.ts", "export const counter = 1;\n");
    commitAll(repoRoot, "counter 1");

    writeTextFile(repoRoot, "src/flag.ts", "export const flag = true;\n");
    commitAll(repoRoot, "add flag");

    writeTextFile(repoRoot, "src/counter.ts", "export const counter = 2;\n");
    commitAll(repoRoot, "counter 2");

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "back:3",
      maxFiles: 20,
    });

    expect(result.ok).toBe(true);
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain("src/counter.ts");
    expect(paths).toContain("src/flag.ts");
  });

  test("caps patches at hunk boundaries", () => {
    const originalLines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
    const repoRoot = createRepo({
      "src/multi.ts": `${originalLines.join("\n")}\n`,
    });

    const updatedLines = [...originalLines];
    updatedLines[1] = "line-2-updated";
    updatedLines[50] = "line-51-updated";
    writeTextFile(repoRoot, "src/multi.ts", `${updatedLines.join("\n")}\n`);

    const fullResult = executeDiffMode({
      cwd: repoRoot,
      mode: "uncommitted",
      maxFiles: 20,
      maxPatchTokens: 10_000,
    });

    expect(fullResult.ok).toBe(true);
    const fullFile = findFile(fullResult.files, "src/multi.ts");
    expect(fullFile).toBeDefined();
    expect(fullFile?.hunks.length).toBeGreaterThan(1);

    const firstHunk = fullFile?.hunks[0];
    expect(firstHunk).toBeDefined();

    const oneHunkBudget = estimatePatchTokens([
      {
        ...fullFile!,
        hunks: [firstHunk!],
      },
    ]);

    const cappedResult = executeDiffMode({
      cwd: repoRoot,
      mode: "uncommitted",
      maxFiles: 20,
      maxPatchTokens: oneHunkBudget,
    });

    const cappedFile = findFile(cappedResult.files, "src/multi.ts");
    expect(cappedResult.ok).toBe(true);
    expect(cappedFile).toBeDefined();
    expect(cappedFile?.hunks).toHaveLength(1);
    expect(cappedResult.capping?.applied).toBe(true);
    expect(cappedResult.truncationNotice).toContain("TRUNCATED");
  });

  test("parses renames in staged mode", () => {
    const repoRoot = createRepo({
      "src/old-name.ts": "export const value = 1;\n",
    });

    runGit(repoRoot, ["mv", "src/old-name.ts", "src/new-name.ts"]);

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "staged",
      maxFiles: 20,
    });

    const renamed = findFile(result.files, "src/new-name.ts");
    expect(result.ok).toBe(true);
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("src/old-name.ts");
  });

  test("marks binary diffs without including hunk content", () => {
    const repoRoot = createRepo({
      "src/app.ts": "export const ok = true;\n",
    });

    writeBinaryFile(
      repoRoot,
      "assets/blob.bin",
      new Uint8Array([0, 1, 2, 3, 0, 255]),
    );
    runGit(repoRoot, ["add", "assets/blob.bin"]);

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "staged",
      maxFiles: 20,
    });

    const binaryFile = findFile(result.files, "assets/blob.bin");
    expect(result.ok).toBe(true);
    expect(binaryFile).toBeDefined();
    expect(binaryFile?.isBinary).toBe(true);
    expect(binaryFile?.hunks).toHaveLength(0);
  });

  test("returns no files when diff mode is off", () => {
    const repoRoot = createRepo({
      "src/app.ts": "export const value = 1;\n",
    });

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "off",
      maxFiles: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([]);
  });

  test("enforces git-max-files cap after relevance ordering", () => {
    const repoRoot = createRepo({
      "src/one.ts": "export const one = 1;\n",
      "src/two.ts": "export const two = 2;\n",
      "src/three.ts": "export const three = 3;\n",
    });

    writeTextFile(repoRoot, "src/one.ts", "export const one = 10;\n");
    writeTextFile(repoRoot, "src/two.ts", "export const two = 20;\n");
    writeTextFile(repoRoot, "src/three.ts", "export const three = 30;\n");

    const result = executeDiffMode({
      cwd: repoRoot,
      mode: "uncommitted",
      maxFiles: 2,
      maxPatchTokens: 10_000,
      selectedPaths: ["src/three.ts"],
    });

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((file) => file.path)).toContain("src/three.ts");
  });

  test("returns structured failure for non-git directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-git-diff-not-repo-"));

    const result = executeDiffMode({
      cwd: tempDir,
      mode: "uncommitted",
      maxFiles: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("NOT_GIT_REPO");
    expect(result.files).toEqual([]);
  });
});
