import { describe, expect, test } from "bun:test";

import type { GitDiffFile } from "../../src/git/diff";
import {
  capPatchFilesByTokens,
  estimatePatchFileTokens,
  formatPatchTruncationMarker,
} from "../../src/git/patch-cap";

function buildFile(path: string, hunks: string[]): GitDiffFile {
  return {
    path,
    status: "modified",
    modeChanged: false,
    isBinary: false,
    hunks: hunks.map((content, index) => ({
      oldStart: index + 1,
      oldCount: 1,
      newStart: index + 1,
      newCount: 1,
      content,
    })),
  };
}

describe("patch token capping", () => {
  test("prioritizes selected and task-matching files before others", () => {
    const files: GitDiffFile[] = [
      buildFile("src/zeta.ts", ["@@ -1 +1 @@\n-old\n+new"]),
      buildFile("src/auth/login.ts", ["@@ -1 +1 @@\n-old\n+new"]),
      buildFile("src/alpha.ts", ["@@ -1 +1 @@\n-old\n+new"]),
    ];

    const result = capPatchFilesByTokens(files, {
      maxPatchTokens: 10_000,
      selectedPaths: ["src/alpha.ts"],
      taskTerms: ["login"],
      charsPerToken: 1,
    });

    expect(result.truncated).toBe(false);
    expect(result.files.map((file) => file.path)).toEqual([
      "src/alpha.ts",
      "src/auth/login.ts",
      "src/zeta.ts",
    ]);
  });

  test("applies maxFiles after relevance ordering", () => {
    const files: GitDiffFile[] = [
      buildFile("src/zzz.ts", ["@@ -1 +1 @@\n-old\n+new"]),
      buildFile("src/important/login.ts", ["@@ -1 +1 @@\n-old\n+new"]),
      buildFile("src/aaa.ts", ["@@ -1 +1 @@\n-old\n+new"]),
    ];

    const result = capPatchFilesByTokens(files, {
      maxPatchTokens: 10_000,
      maxFiles: 1,
      selectedPaths: [],
      taskTerms: ["login"],
      charsPerToken: 1,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("src/important/login.ts");
    expect(result.truncated).toBe(true);
    expect(result.truncatedFiles).toBe(2);
  });

  test("truncates at hunk boundary and emits truncation marker", () => {
    const file = buildFile("src/large.ts", [
      "@@ -1 +1 @@\n-old line\n+new line",
      "@@ -10 +10 @@\n-old ten\n+new ten",
      "@@ -20 +20 @@\n-old twenty\n+new twenty",
    ]);
    const firstTwoHunks = { ...file, hunks: file.hunks.slice(0, 2) };

    const budget = estimatePatchFileTokens(firstTwoHunks, { charsPerToken: 1 }) + 1;
    const result = capPatchFilesByTokens([file], {
      maxPatchTokens: budget,
      charsPerToken: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.hunks).toHaveLength(2);
    expect(result.truncatedFiles).toBe(1);
    expect(result.marker).toBeDefined();
    expect(result.marker).toContain("TRUNCATED");
  });

  test("formats truncation marker deterministically", () => {
    expect(formatPatchTruncationMarker(3, 1234)).toBe(
      "... ‹TRUNCATED: 3 more files, ~1234 tokens›",
    );
  });

  test("drops overflowing binary file when it cannot fit", () => {
    const binaryFile: GitDiffFile = {
      path: "assets/logo.png",
      status: "added",
      modeChanged: false,
      isBinary: true,
      hunks: [],
    };

    const result = capPatchFilesByTokens([binaryFile], {
      maxPatchTokens: 1,
      charsPerToken: 1,
    });

    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedFiles).toBe(1);
  });
});
