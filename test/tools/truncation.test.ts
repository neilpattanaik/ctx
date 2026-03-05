import { describe, expect, test } from "bun:test";

import {
  enforceCodemapTruncation,
  enforceDeterministicToolTruncation,
  enforceFileSearchTruncation,
  enforceFileTreeTruncation,
  enforceReadFileTruncation,
} from "../../src/tools";

describe("enforceFileSearchTruncation", () => {
  test("sorts deterministically and applies file/excerpt caps", () => {
    const result = enforceFileSearchTruncation(
      {
        pattern: "OAuth",
        mode: "content",
        results: [
          {
            path: "src/z.ts",
            hits: 2,
            top_excerpts: [
              { line: 30, excerpt: "delta", match: "OAuth" },
              { line: 10, excerpt: "gamma", match: "OAuth" },
            ],
          },
          {
            path: "src/a.ts",
            hits: 8,
            top_excerpts: [
              { line: 22, excerpt: "a very long excerpt to trim", match: "OAuth" },
              { line: 12, excerpt: "alpha", match: "OAuth" },
              { line: 16, excerpt: "beta", match: "OAuth" },
            ],
          },
          {
            path: "src/ignored.ts",
            hits: 1,
            top_excerpts: [{ line: 2, excerpt: "ignored", match: "OAuth" }],
          },
        ],
      },
      {
        maxFiles: 2,
        maxExcerptsPerFile: 2,
        maxExcerptChars: 10,
      },
    );

    expect(result.results.map((item) => item.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(result.results[0]?.top_excerpts.map((excerpt) => excerpt.line)).toEqual([
      12,
      16,
    ]);
    expect(result.results[0]?.top_excerpts[1]?.excerpt).toBe("beta");
    expect(result.truncation).toEqual({
      maxFiles: 2,
      maxExcerptsPerFile: 2,
      maxExcerptChars: 10,
      truncated: true,
      omittedFiles: 1,
      omittedExcerpts: 1,
    });
  });

  test("always includes truncation metadata even without omissions", () => {
    const result = enforceFileSearchTruncation({
      pattern: "auth",
      mode: "path",
      results: [
        {
          path: "src/a.ts",
          hits: 1,
          top_excerpts: [{ line: 1, excerpt: "auth", match: "auth" }],
        },
      ],
    });

    expect(result.truncation?.truncated).toBe(false);
    expect(result.truncation?.omittedFiles).toBe(0);
    expect(result.truncation?.omittedExcerpts).toBe(0);
  });
});

describe("enforceCodemapTruncation", () => {
  test("applies deterministic file/symbol ordering and caps", () => {
    const result = enforceCodemapTruncation(
      {
        paths: ["src"],
        detail: "summary",
        results: [
          {
            path: "src/z.ts",
            language: "typescript",
            lines: 10,
            symbols: [{ kind: "function", signature: "zeta", line: 5 }],
          },
          {
            path: "src/a.ts",
            language: "typescript",
            lines: 30,
            symbols: [
              {
                kind: "class",
                signature: "export class LongLongLongLongName {}",
                line: 9,
              },
              { kind: "function", signature: "alpha", line: 2 },
              { kind: "function", signature: "beta", line: 6 },
            ],
          },
        ],
      },
      {
        maxResults: 1,
        maxSymbols: 2,
        maxSignatureChars: 12,
      },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("src/a.ts");
    expect(result.results[0]?.symbols.map((symbol) => symbol.line)).toEqual([2, 6]);
    expect(result.results[0]?.truncation).toEqual({
      max_symbols: 2,
      max_signature_chars: 12,
      truncated: true,
      omitted_symbols: 1,
    });
    expect(result.truncation).toEqual({
      max_results: 1,
      truncated: true,
      omitted_files: 1,
    });
  });
});

describe("enforceReadFileTruncation", () => {
  test("renders line numbers and deterministic truncation footer", () => {
    const result = enforceReadFileTruncation(
      {
        path: "src/app.ts",
        content: "alpha\nbeta\ngamma\n",
      },
      {
        startLine: 10,
        limit: 2,
      },
    );

    expect(result.content).toBe(
      ["0010| alpha", "0011| beta", "... ‹TRUNCATED: limit=2›", ""].join("\n"),
    );
    expect(result.truncation).toEqual({
      line_numbers: true,
      limit: 2,
      truncated: true,
      original_line_count: 3,
      returned_line_count: 2,
      footer: "... ‹TRUNCATED: limit=2›",
    });
  });
});

describe("enforceFileTreeTruncation", () => {
  test("caps entries per level and prunes deeper branches deterministically", () => {
    const result = enforceFileTreeTruncation(
      {
        mode: "full",
        entries: [
          {
            path: "src",
            kind: "directory",
            children: [
              { path: "src/z.ts", kind: "file" },
              {
                path: "src/lib",
                kind: "directory",
                children: [{ path: "src/lib/core.ts", kind: "file" }],
              },
              { path: "src/a.ts", kind: "file" },
            ],
          },
          {
            path: "docs",
            kind: "directory",
            children: [
              { path: "docs/intro.md", kind: "file" },
              { path: "docs/api.md", kind: "file" },
              { path: "docs/extra.md", kind: "file" },
            ],
          },
          { path: "zzz.tmp", kind: "file" },
        ],
      },
      {
        maxDepth: 2,
        maxEntriesPerLevel: 2,
      },
    );

    expect(result.entries.map((entry) => entry.path)).toEqual(["docs", "src"]);
    expect(result.entries[0]?.children?.map((entry) => entry.path)).toEqual([
      "docs/api.md",
      "docs/extra.md",
    ]);
    expect(result.entries[1]?.children?.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/lib",
    ]);
    expect(result.entries[1]?.children?.[1]?.children).toBeUndefined();
    expect(result.truncation).toEqual({
      maxDepth: 2,
      maxEntriesPerLevel: 2,
      truncated: true,
      omittedEntries: 4,
      depthPruned: true,
    });
  });
});

describe("enforceDeterministicToolTruncation", () => {
  test("dispatches to the tool-specific enforcer", () => {
    const result = enforceDeterministicToolTruncation(
      "read_file",
      {
        path: "src/a.ts",
        content: "first\nsecond\n",
      },
      {
        readFile: { limit: 1 },
      },
    );

    expect(result.truncation?.truncated).toBe(true);
    expect(result.content).toBe(
      ["0001| first", "... ‹TRUNCATED: limit=1›", ""].join("\n"),
    );
  });
});
