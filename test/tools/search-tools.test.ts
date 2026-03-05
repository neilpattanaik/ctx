import { describe, expect, test } from "bun:test";
import type { SearchContentResponse, SearchPathResponse } from "../../src/search";
import {
  FileSearchToolError,
  executeFileSearch,
  validateFileSearchArgs,
} from "../../src/tools/search-tools";

function contentResponse(
  overrides: Partial<SearchContentResponse> = {},
): SearchContentResponse {
  return {
    ok: true,
    available: true,
    hits: [],
    stderr: "",
    ...overrides,
  };
}

function pathResponse(overrides: Partial<SearchPathResponse> = {}): SearchPathResponse {
  return {
    ok: true,
    available: true,
    paths: [],
    stderr: "",
    ...overrides,
  };
}

describe("file_search arg validation", () => {
  test("validates argument shape and required fields", () => {
    expect(validateFileSearchArgs({ pattern: "auth" })).toEqual({ ok: true });

    expect(validateFileSearchArgs(undefined)).toEqual({
      ok: false,
      message: "args must be an object",
    });

    expect(validateFileSearchArgs({ pattern: "" })).toEqual({
      ok: false,
      message: "args.pattern must be a non-empty string",
    });

    expect(validateFileSearchArgs({ pattern: "auth", mode: "weird" })).toEqual({
      ok: false,
      message: "args.mode must be one of: content, path, both, auto",
    });

    expect(
      validateFileSearchArgs({ pattern: "auth", filter: { extensions: ["", ".ts"] } }),
    ).toEqual({
      ok: false,
      message: "args.filter.extensions must be an array of non-empty strings",
    });

    expect(validateFileSearchArgs({ pattern: "(", regex: true })).toEqual({
      ok: false,
      message: "args.pattern must be a valid regex when args.regex=true",
    });
  });
});

describe("executeFileSearch", () => {
  test("runs content mode with deterministic ordering and truncation", () => {
    const result = executeFileSearch(
      {
        pattern: "token",
        mode: "content",
        max_results: 1,
      },
      {
        cwd: process.cwd(),
        isRipgrepAvailableImpl: () => true,
        searchContentImpl: () =>
          contentResponse({
            hits: [
              {
                path: "src/b.ts",
                line: 4,
                column: 3,
                excerpt: "beta token",
                submatches: ["token"],
                beforeContext: [],
                afterContext: [],
              },
              {
                path: "src/a.ts",
                line: 3,
                column: 1,
                excerpt: "alpha token",
                submatches: ["token"],
                beforeContext: [],
                afterContext: [],
              },
              {
                path: "src/a.ts",
                line: 1,
                column: 1,
                excerpt: "token start",
                submatches: ["token"],
                beforeContext: [],
                afterContext: [],
              },
            ],
          }),
      },
    );

    expect(result.mode).toBe("content");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("src/a.ts");
    expect(result.results[0]?.hits).toBe(2);
    expect(result.results[0]?.top_excerpts.map((entry) => entry.line)).toEqual([1, 3]);
    expect(result.truncation).toEqual({
      maxFiles: 1,
      maxExcerptsPerFile: 3,
      maxExcerptChars: 200,
      truncated: true,
      omittedFiles: 1,
      omittedExcerpts: 0,
    });
  });

  test("auto mode resolves to both for path-like patterns and merges results", () => {
    const result = executeFileSearch(
      {
        pattern: "src/lib",
        mode: "auto",
      },
      {
        cwd: process.cwd(),
        isRipgrepAvailableImpl: () => true,
        searchContentImpl: () =>
          contentResponse({
            hits: [
              {
                path: "src/lib/a.ts",
                line: 2,
                column: 1,
                excerpt: "import src/lib/a",
                submatches: ["src/lib"],
                beforeContext: [],
                afterContext: [],
              },
            ],
          }),
        searchPathsImpl: () =>
          pathResponse({
            paths: ["src/lib/b.ts", "src/lib/a.ts"],
          }),
      },
    );

    expect(result.mode).toBe("both");
    expect(result.results.map((entry) => [entry.path, entry.hits])).toEqual([
      ["src/lib/a.ts", 2],
      ["src/lib/b.ts", 1],
    ]);
    expect(result.results[1]?.top_excerpts).toEqual([]);
  });

  test("uses fallback search backend when ripgrep is unavailable", () => {
    let usedFallback = false;

    const result = executeFileSearch(
      {
        pattern: "ctx",
        mode: "path",
      },
      {
        cwd: process.cwd(),
        repoFiles: ["src/index.ts", "README.md"],
        isRipgrepAvailableImpl: () => false,
        searchPathsFallbackImpl: (_pattern, options) => {
          usedFallback = true;
          expect(options.files).toEqual(["src/index.ts", "README.md"]);
          return pathResponse({ paths: ["src/index.ts"] });
        },
      },
    );

    expect(usedFallback).toBe(true);
    expect(result.results).toEqual([
      {
        path: "src/index.ts",
        hits: 1,
        top_excerpts: [],
      },
    ]);
  });

  test("throws UNAVAILABLE when fallback is required but repo file list is missing", () => {
    expect(() =>
      executeFileSearch(
        {
          pattern: "src",
          mode: "path",
        },
        {
          cwd: process.cwd(),
          isRipgrepAvailableImpl: () => false,
        },
      ),
    ).toThrowError(
      new FileSearchToolError(
        "UNAVAILABLE",
        "file_search fallback requires repoFiles when ripgrep is unavailable",
      ),
    );
  });

  test("maps backend parse errors to INVALID_ARGS", () => {
    expect(() =>
      executeFileSearch(
        {
          pattern: "auth",
          mode: "content",
        },
        {
          cwd: process.cwd(),
          isRipgrepAvailableImpl: () => true,
          searchContentImpl: () =>
            contentResponse({
              ok: false,
              error: {
                code: "PARSE_ERROR",
                message: "invalid regex pattern",
              },
            }),
        },
      ),
    ).toThrowError(
      new FileSearchToolError("INVALID_ARGS", "invalid regex pattern"),
    );
  });
});
