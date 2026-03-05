import { describe, expect, test } from "bun:test";
import {
  formatContentSearchResults,
  type FormattedSearchResultPayload,
} from "../../src/search/format";
import type { SearchContentHit } from "../../src/search/ripgrep";

function makeHit(
  path: string,
  line: number,
  excerpt: string,
  match: string,
): SearchContentHit {
  return {
    path,
    line,
    column: 1,
    excerpt,
    submatches: [match],
    beforeContext: [],
    afterContext: [],
  };
}

describe("formatContentSearchResults", () => {
  test("sorts by hit count descending then path ascending", () => {
    const hits: SearchContentHit[] = [
      makeHit("src/c.ts", 8, "match", "match"),
      makeHit("src/b.ts", 2, "match", "match"),
      makeHit("src/b.ts", 9, "match", "match"),
      makeHit("src/c.ts", 4, "match", "match"),
      makeHit("src/a.ts", 1, "match", "match"),
    ];

    const result = formatContentSearchResults("match", hits, {
      maxFiles: 3,
      maxExcerptsPerFile: 3,
    });

    expect(result.results.map((entry) => entry.path)).toEqual([
      "src/b.ts",
      "src/c.ts",
      "src/a.ts",
    ]);
    expect(result.results.map((entry) => entry.hits)).toEqual([2, 2, 1]);
  });

  test("keeps earliest line excerpts per file with deterministic cap", () => {
    const hits: SearchContentHit[] = [
      makeHit("src/a.ts", 30, "z", "z"),
      makeHit("src/a.ts", 10, "b", "b"),
      makeHit("src/a.ts", 20, "a", "a"),
      makeHit("src/a.ts", 40, "x", "x"),
    ];

    const result = formatContentSearchResults("x", hits, {
      maxExcerptsPerFile: 3,
    });
    const excerpts = result.results[0]?.top_excerpts ?? [];

    expect(excerpts.map((excerpt) => excerpt.line)).toEqual([10, 20, 30]);
    expect(excerpts.map((excerpt) => excerpt.excerpt)).toEqual(["b", "a", "z"]);
  });

  test("truncates excerpts to maxExcerptChars with ellipsis", () => {
    const hits: SearchContentHit[] = [
      makeHit("src/a.ts", 1, "abcdefghijklmnopqrstuvwxyz", "abc"),
    ];

    const result = formatContentSearchResults("abc", hits, {
      maxExcerptChars: 8,
    });

    expect(result.results[0]?.top_excerpts[0]?.excerpt).toBe("abcdefg…");
  });

  test("caps files and always includes truncation metadata", () => {
    const hits: SearchContentHit[] = [
      makeHit("src/a.ts", 1, "a", "a"),
      makeHit("src/b.ts", 1, "b", "b"),
      makeHit("src/c.ts", 1, "c", "c"),
    ];

    const result: FormattedSearchResultPayload = formatContentSearchResults(
      "a",
      hits,
      {
        maxFiles: 2,
        maxExcerptsPerFile: 1,
        maxExcerptChars: 16,
      },
    );

    expect(result.results).toHaveLength(2);
    expect(result.truncation).toEqual({
      max_files: 2,
      max_excerpts_per_file: 1,
      max_excerpt_chars: 16,
    });
  });

  test("returns empty results with default truncation metadata", () => {
    const result = formatContentSearchResults("nothing", []);

    expect(result.results).toEqual([]);
    expect(result.truncation).toEqual({
      max_files: 50,
      max_excerpts_per_file: 3,
      max_excerpt_chars: 200,
    });
  });
});
