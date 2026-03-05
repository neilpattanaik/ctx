import { describe, expect, test } from "bun:test";
import { detectRepoRoot, RepoRootError } from "../../src/scanner/repo-root";

describe("detectRepoRoot", () => {
  test("uses --repo flag when provided", () => {
    const root = detectRepoRoot({
      repoFlag: ".",
      cwd: "/tmp",
      resolveGitRoot: () => null,
    });

    expect(root).toBe(process.cwd());
  });

  test("throws exit-code 3 error for invalid explicit --repo path", () => {
    expect(() =>
      detectRepoRoot({
        repoFlag: "/definitely/missing/repo/path",
      }),
    ).toThrowError(RepoRootError);

    try {
      detectRepoRoot({ repoFlag: "/definitely/missing/repo/path" });
    } catch (error) {
      expect(error).toBeInstanceOf(RepoRootError);
      expect((error as RepoRootError).exitCode).toBe(3);
    }
  });

  test("uses git root when repo flag is absent and git root resolves", () => {
    const root = detectRepoRoot({
      cwd: "/tmp",
      resolveGitRoot: () => ".",
    });

    expect(root).toBe(process.cwd());
  });

  test("falls back to cwd when git root cannot be resolved", () => {
    const root = detectRepoRoot({
      cwd: ".",
      resolveGitRoot: () => null,
    });

    expect(root).toBe(process.cwd());
  });

  test("falls back to cwd when resolved git root is invalid", () => {
    const root = detectRepoRoot({
      cwd: ".",
      resolveGitRoot: () => "/path/that/does/not/exist",
    });

    expect(root).toBe(process.cwd());
  });
});
