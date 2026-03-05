import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  isRipgrepAvailable,
  searchContent,
  searchPaths,
} from "../../src/search/ripgrep";

function createTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "ctx-ripgrep-integration-"));
}

function writeText(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function skipWhenRipgrepMissing(): boolean {
  return !isRipgrepAvailable({ cwd: process.cwd() });
}

describe("ripgrep integration", () => {
  test("searchContent returns real matches with context", () => {
    if (skipWhenRipgrepMissing()) {
      expect(true).toBe(true);
      return;
    }

    const repoRoot = createTempRepo();
    writeText(
      repoRoot,
      "src/auth.ts",
      [
        "before line",
        "const token = read();",
        "after line",
      ].join("\n"),
    );

    const result = searchContent("token", {
      cwd: repoRoot,
      contextLines: 1,
      maxCountPerFile: 10,
      maxFileSizeBytes: 2048,
    });

    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.hits).toEqual([
      {
        path: "src/auth.ts",
        line: 2,
        column: 7,
        excerpt: "const token = read();",
        submatches: ["token"],
        beforeContext: ["before line"],
        afterContext: ["after line"],
      },
    ]);
  });

  test("searchPaths applies rg file listing and deterministic filters", () => {
    if (skipWhenRipgrepMissing()) {
      expect(true).toBe(true);
      return;
    }

    const repoRoot = createTempRepo();
    writeText(repoRoot, "src/auth/login.ts", "export const login = true;\n");
    writeText(repoRoot, "src/auth/service.ts", "export const service = true;\n");
    writeText(repoRoot, "src/router.ts", "export const router = true;\n");
    writeText(repoRoot, "docs/auth.md", "auth docs\n");

    const result = searchPaths("auth", {
      cwd: repoRoot,
      extensions: ["ts", ".md"],
      pathFilter: ["src/**"],
      exclude: ["src/auth/service.ts"],
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["src/auth/login.ts"]);
  });

  test("reports unavailable when rgPath points to a missing executable", () => {
    const repoRoot = createTempRepo();
    writeText(repoRoot, "src/file.ts", "needle\n");

    const contentResult = searchContent("needle", {
      cwd: repoRoot,
      rgPath: "/definitely/missing/rg",
    });
    const pathResult = searchPaths("file", {
      cwd: repoRoot,
      rgPath: "/definitely/missing/rg",
    });

    expect(contentResult.ok).toBe(false);
    expect(contentResult.available).toBe(false);
    expect(contentResult.error?.code).toBe("UNAVAILABLE");

    expect(pathResult.ok).toBe(false);
    expect(pathResult.available).toBe(false);
    expect(pathResult.error?.code).toBe("UNAVAILABLE");

    expect(
      isRipgrepAvailable({
        cwd: repoRoot,
        rgPath: "/definitely/missing/rg",
      }),
    ).toBe(false);
  });
});
