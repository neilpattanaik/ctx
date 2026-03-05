import { describe, expect, test } from "bun:test";
import type { runGitCommand } from "../../src/git";
import {
  applyPatchTokenCap,
  estimatePatchTokens,
  executeDiffMode,
  parseUnifiedDiff,
  resolveDiffCommand,
} from "../../src/git";

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "@@ -1,2 +1,3 @@",
  "-line1",
  "+line1 updated",
  " line2",
  "+line3",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "@@ -0,0 +1,2 @@",
  "+alpha",
  "+beta",
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "@@ -1,2 +0,0 @@",
  "-old1",
  "-old2",
  "diff --git a/src/from.ts b/src/to.ts",
  "similarity index 98%",
  "rename from src/from.ts",
  "rename to src/to.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "new file mode 100644",
  "index 0000000..9999999",
  "Binary files /dev/null and b/assets/logo.png differ",
].join("\n");

describe("resolveDiffCommand", () => {
  test("maps supported diff modes to git arguments", () => {
    expect(resolveDiffCommand("off")).toEqual({ enabled: false, args: [] });
    expect(resolveDiffCommand("uncommitted")).toEqual({
      enabled: true,
      args: ["diff", "HEAD"],
    });
    expect(resolveDiffCommand("staged")).toEqual({
      enabled: true,
      args: ["diff", "--cached"],
    });
    expect(resolveDiffCommand("unstaged")).toEqual({
      enabled: true,
      args: ["diff"],
    });
    expect(resolveDiffCommand("main")).toEqual({
      enabled: true,
      args: ["diff", "main...HEAD"],
    });
    expect(resolveDiffCommand("compare:HEAD~3")).toEqual({
      enabled: true,
      args: ["diff", "HEAD~3"],
    });
    expect(resolveDiffCommand("back:2")).toEqual({
      enabled: true,
      args: ["diff", "HEAD~2"],
    });
    expect(resolveDiffCommand("feature-branch")).toEqual({
      enabled: true,
      args: ["diff", "feature-branch...HEAD"],
    });
  });

  test("rejects invalid back diff mode values", () => {
    expect(() => resolveDiffCommand("back:0")).toThrow("Invalid back diff mode");
    expect(() => resolveDiffCommand("back:not-a-number")).toThrow(
      "Invalid back diff mode",
    );
  });
});

describe("parseUnifiedDiff", () => {
  test("parses file status, hunk metadata, rename metadata, and binary markers", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files).toHaveLength(5);

    const modified = files.find((file) => file.path === "src/a.ts");
    expect(modified?.status).toBe("modified");
    expect(modified?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 3,
    });

    const added = files.find((file) => file.path === "src/new.ts");
    expect(added?.status).toBe("added");

    const deleted = files.find((file) => file.path === "src/old.ts");
    expect(deleted?.status).toBe("deleted");

    const renamed = files.find((file) => file.path === "src/to.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("src/from.ts");

    const binary = files.find((file) => file.path === "assets/logo.png");
    expect(binary?.isBinary).toBe(true);
    expect(binary?.hunks).toHaveLength(0);
  });
});

describe("applyPatchTokenCap", () => {
  test("keeps file list unchanged when within patch token budget", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const fullBudget = estimatePatchTokens(files);

    const capped = applyPatchTokenCap({ files, maxPatchTokens: fullBudget });

    expect(capped.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(capped.capping.applied).toBe(false);
    expect(capped.capping.marker).toBeUndefined();
  });

  test("prioritizes relevance paths before size tie-breakers", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const target = files.find((file) => file.path === "src/new.ts");
    expect(target).toBeDefined();

    const budget = estimatePatchTokens([target!]);
    const capped = applyPatchTokenCap({
      files,
      maxPatchTokens: budget,
      relevancePaths: ["src/new.ts"],
    });

    expect(capped.files).toHaveLength(1);
    expect(capped.files[0]?.path).toBe("src/new.ts");
    expect(capped.capping.applied).toBe(true);
  });

  test("truncates at hunk boundaries for partially fitting files", () => {
    const multiHunkFile = {
      path: "src/multi.ts",
      status: "modified" as const,
      modeChanged: false,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          content: "@@ -1 +1 @@\n-aaa\n+bbb",
        },
        {
          oldStart: 10,
          oldCount: 1,
          newStart: 10,
          newCount: 1,
          content: "@@ -10 +10 @@\n-cccccccccc\n+dddddddddd",
        },
      ],
    };

    const oneHunkBudget = estimatePatchTokens([
      {
        ...multiHunkFile,
        hunks: [multiHunkFile.hunks[0]!],
      },
    ]);

    const capped = applyPatchTokenCap({
      files: [multiHunkFile],
      maxPatchTokens: oneHunkBudget,
    });

    expect(capped.files).toHaveLength(1);
    expect(capped.files[0]?.hunks).toHaveLength(1);
    expect(capped.capping.applied).toBe(true);
    expect(capped.capping.marker).toContain("TRUNCATED");
  });
});

describe("executeDiffMode", () => {
  test("returns empty file list when diff mode is off", () => {
    const result = executeDiffMode({
      cwd: process.cwd(),
      mode: "off",
      maxFiles: 20,
      runGitCommandImpl: (() => {
        throw new Error("runGit should not be called for mode=off");
      }) as unknown as typeof runGitCommand,
    });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([]);
  });

  test("parses git diff output and caps files by hunk size", () => {
    const fakeRunGit = (() => ({
      ok: true,
      stdout: SAMPLE_DIFF,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })) as unknown as typeof runGitCommand;

    const result = executeDiffMode({
      cwd: process.cwd(),
      mode: "uncommitted",
      maxFiles: 2,
      runGitCommandImpl: fakeRunGit,
    });

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.path).toBe("src/a.ts");
  });

  test("enforces maxPatchTokens and emits truncation metadata", () => {
    const fakeRunGit = (() => ({
      ok: true,
      stdout: SAMPLE_DIFF,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })) as unknown as typeof runGitCommand;

    const result = executeDiffMode({
      cwd: process.cwd(),
      mode: "uncommitted",
      maxFiles: 20,
      maxPatchTokens: 20,
      relevancePaths: ["src/new.ts"],
      runGitCommandImpl: fakeRunGit,
    });

    expect(result.ok).toBe(true);
    expect(result.capping).toBeDefined();
    expect(result.capping?.usedPatchTokens).toBeLessThanOrEqual(20);
    expect(result.capping?.applied).toBe(true);
    expect(result.capping?.marker).toContain("TRUNCATED");
  });

  test("bubbles command failure metadata", () => {
    const fakeRunGit = (() => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
      failureKind: "NOT_GIT_REPO" as const,
    })) as unknown as typeof runGitCommand;

    const result = executeDiffMode({
      cwd: process.cwd(),
      mode: "staged",
      maxFiles: 20,
      runGitCommandImpl: fakeRunGit,
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("NOT_GIT_REPO");
    expect(result.files).toHaveLength(0);
  });
});
