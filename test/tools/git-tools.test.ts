import { describe, expect, test } from "bun:test";
import type { executeDiffMode } from "../../src/git";
import {
  GitToolError,
  executeGitDiffTool,
  executeGitStatusTool,
  validateGitDiffArgs,
} from "../../src/tools/git-tools";

describe("git tool arg validation", () => {
  test("validates git_diff args shape", () => {
    expect(validateGitDiffArgs(undefined)).toEqual({ ok: true });
    expect(
      validateGitDiffArgs({
        compare: "staged",
        detail: "summary",
        scope: "selected",
        max_files: 10,
      }),
    ).toEqual({ ok: true });
    expect(validateGitDiffArgs({ detail: "invalid" })).toEqual({
      ok: false,
      message: "args.detail must be one of: summary, patches, full",
    });
    expect(validateGitDiffArgs({ scope: "invalid" })).toEqual({
      ok: false,
      message: "args.scope must be one of: all, selected",
    });
    expect(validateGitDiffArgs({ max_files: 0 })).toEqual({
      ok: false,
      message: "args.max_files must be a positive integer",
    });
  });
});

describe("executeGitStatusTool", () => {
  test("returns deterministic git status summary", async () => {
    const result = await executeGitStatusTool({
      cwd: process.cwd(),
      collectGitStatusImpl: () => ({
        branch: "main",
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
        changes: [
          { path: "src/z.ts", status: "modified" },
          { path: "src/a.ts", status: "added" },
        ],
      }),
    });

    expect(result).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      changes: [
        { path: "src/a.ts", status: "added" },
        { path: "src/z.ts", status: "modified" },
      ],
    });
  });

  test("throws NOT_FOUND when status collection returns null", async () => {
    await expect(
      executeGitStatusTool({
        cwd: process.cwd(),
        collectGitStatusImpl: () => null,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    } satisfies Partial<GitToolError>);
  });
});

describe("executeGitDiffTool", () => {
  const diffFiles = [
    {
      path: "src/a.ts",
      status: "modified" as const,
      modeChanged: false,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          content: "@@ -1 +1,2 @@\n-old\n+new\n+extra",
        },
      ],
    },
    {
      path: "src/b.ts",
      status: "deleted" as const,
      modeChanged: true,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 0,
          newCount: 0,
          content: "@@ -1,2 +0,0 @@\n-gone\n-also-gone",
        },
      ],
    },
  ];

  const fakeExecuteDiff = (() => ({
    ok: true,
    mode: "staged",
    files: diffFiles,
    stderr: "",
    capping: {
      applied: true,
      maxPatchTokens: 6000,
      usedPatchTokens: 120,
      omittedFiles: 0,
      omittedTokensApprox: 0,
    },
  })) as unknown as typeof executeDiffMode;

  test("returns summary detail with stats and max_files cap", async () => {
    const result = await executeGitDiffTool(
      {
        compare: "staged",
        detail: "summary",
        max_files: 1,
      },
      {
        cwd: process.cwd(),
        executeDiffModeImpl: fakeExecuteDiff,
      },
    );

    expect(result.compare).toBe("staged");
    expect(result.files).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        stats: { additions: 2, deletions: 1 },
      },
    ]);
  });

  test("returns patch/full detail and honors selected scope filtering", async () => {
    const patchResult = await executeGitDiffTool(
      {
        detail: "patches",
        scope: "selected",
      },
      {
        cwd: process.cwd(),
        selectedPaths: ["src/b.ts"],
        executeDiffModeImpl: fakeExecuteDiff,
      },
    );

    expect(patchResult.files).toHaveLength(1);
    expect((patchResult.files[0] as { path: string }).path).toBe("src/b.ts");
    expect(
      (patchResult.files[0] as { hunks: Array<{ content: string }> }).hunks[0]?.content,
    ).toContain("gone");

    const fullResult = await executeGitDiffTool(
      {
        detail: "full",
      },
      {
        cwd: process.cwd(),
        executeDiffModeImpl: fakeExecuteDiff,
      },
    );
    const first = fullResult.files[0] as {
      old_path?: string;
      mode_changed: boolean;
      is_binary: boolean;
    };
    expect(first.mode_changed).toBe(false);
    expect(first.is_binary).toBe(false);
  });

  test("throws NOT_FOUND when git diff execution fails", async () => {
    const failingExecuteDiff = (() => ({
      ok: false,
      mode: "staged",
      files: [],
      stderr: "fatal: not a git repository",
      failureKind: "NOT_GIT_REPO" as const,
    })) as unknown as typeof executeDiffMode;

    await expect(
      executeGitDiffTool(
        {
          compare: "staged",
        },
        {
          cwd: process.cwd(),
          executeDiffModeImpl: failingExecuteDiff,
        },
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    } satisfies Partial<GitToolError>);
  });
});
