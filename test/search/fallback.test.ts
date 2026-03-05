import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  searchContentFallback,
  searchPathsFallback,
} from "../../src/search/fallback";

function createTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "ctx-search-fallback-"));
}

function writeText(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

describe("searchContentFallback", () => {
  test("finds literal matches with context and per-file/total caps", () => {
    const repoRoot = createTempRepo();
    writeText(
      repoRoot,
      "src/a.ts",
      [
        "line 1",
        "auth match one",
        "line 3",
        "auth match two",
        "line 5",
      ].join("\n"),
    );
    writeText(
      repoRoot,
      "src/b.ts",
      [
        "before",
        "auth in b",
        "after",
      ].join("\n"),
    );

    const result = searchContentFallback("auth", {
      cwd: repoRoot,
      files: ["src/b.ts", "src/a.ts"],
      contextLines: 1,
      maxCountPerFile: 1,
      maxResults: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        column: 1,
        excerpt: "auth match one",
        submatches: ["auth"],
        beforeContext: ["line 1"],
        afterContext: ["line 3"],
      },
      {
        path: "src/b.ts",
        line: 2,
        column: 1,
        excerpt: "auth in b",
        submatches: ["auth"],
        beforeContext: ["before"],
        afterContext: ["after"],
      },
    ]);
  });

  test("applies extension/include/exclude path filters", () => {
    const repoRoot = createTempRepo();
    writeText(repoRoot, "src/keep.ts", "target");
    writeText(repoRoot, "src/skip/blocked.ts", "target");
    writeText(repoRoot, "docs/readme.md", "target");

    const result = searchContentFallback("target", {
      cwd: repoRoot,
      files: ["docs/readme.md", "src/skip/blocked.ts", "src/keep.ts"],
      extensions: ["ts"],
      pathFilter: ["src/**"],
      exclude: ["src/skip/**"],
    });

    expect(result.ok).toBe(true);
    expect(result.hits.map((hit) => hit.path)).toEqual(["src/keep.ts"]);
  });

  test("returns parse error for invalid regex patterns", () => {
    const result = searchContentFallback("[", {
      cwd: process.cwd(),
      files: [],
      regex: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PARSE_ERROR");
  });
});

describe("searchPathsFallback", () => {
  test("matches paths deterministically with filters and maxResults", () => {
    const result = searchPathsFallback("auth", {
      cwd: process.cwd(),
      files: [
        "src/router.ts",
        "src/auth/login.ts",
        "src/auth/service.ts",
        "docs/auth.md",
      ],
      extensions: ["ts"],
      pathFilter: ["src/**"],
      maxResults: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["src/auth/login.ts"]);
  });

  test("returns parse error for invalid regex patterns", () => {
    const result = searchPathsFallback("[", {
      cwd: process.cwd(),
      files: ["src/a.ts"],
      regex: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PARSE_ERROR");
  });
});
