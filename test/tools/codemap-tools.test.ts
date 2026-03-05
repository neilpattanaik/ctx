import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeSitterCodemapParser } from "../../src/codemap";
import {
  CodemapToolError,
  executeCodemap,
  validateCodemapArgs,
} from "../../src/tools/codemap-tools";

describe("codemap tool arg validation", () => {
  test("validates codemap args shape", () => {
    expect(validateCodemapArgs({ paths: ["src"] })).toEqual({ ok: true });
    expect(validateCodemapArgs({ paths: [] })).toEqual({
      ok: false,
      message: "args.paths must be a non-empty array of strings",
    });
    expect(validateCodemapArgs({ paths: ["src"], detail: "bad" })).toEqual({
      ok: false,
      message: "args.detail must be one of: summary, complete",
    });
    expect(validateCodemapArgs({ paths: ["src"], max_symbols: 0 })).toEqual({
      ok: false,
      message: "args.max_symbols must be a positive integer",
    });
    expect(validateCodemapArgs({ paths: ["src"], max_results: -1 })).toEqual({
      ok: false,
      message: "args.max_results must be a positive integer",
    });
  });
});

describe("codemap tool execution", () => {
  test("expands directories, normalizes results, and applies truncation", async () => {
    let requested: string[] = [];
    const payload = await executeCodemap(
      {
        paths: ["src", "src/a.ts"],
        detail: "summary",
        max_symbols: 1,
        max_results: 2,
      },
      {
        repoRoot: "/repo",
        repoFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "README.md"],
        codemapLookup: async (paths) => {
          requested = [...paths];
          return [
            {
              path: "src/b.ts",
              language: "typescript",
              lines: 20,
              symbols: [
                {
                  kind: "function",
                  signature: "f".repeat(300),
                  line: 3,
                },
                {
                  kind: "class",
                  signature: "AuthService",
                  line: 1,
                },
              ],
            },
            {
              path: "src/a.ts",
              language: "typescript",
              lines: 10,
              symbols: [
                {
                  kind: "function",
                  signature: "two",
                  line: 2,
                },
                {
                  kind: "function",
                  signature: "one",
                  line: 1,
                },
              ],
            },
          ];
        },
      },
    );

    expect(requested).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.paths).toEqual(["src", "src/a.ts"]);
    expect(payload.results.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.results[0]?.symbols).toEqual([
      expect.objectContaining({ line: 1, signature: "one" }),
    ]);
    expect(payload.results[1]?.symbols).toEqual([
      expect.objectContaining({ line: 1, signature: "AuthService" }),
    ]);
    expect(payload.results[0]?.truncation?.truncated).toBe(true);
    expect(payload.truncation?.truncated).toBe(true);
  });

  test("throws NOT_FOUND for missing paths", async () => {
    await expect(
      executeCodemap(
        { paths: ["missing.ts"] },
        {
          repoRoot: "/repo",
          repoFiles: ["src/a.ts"],
        },
      ),
    ).rejects.toMatchObject<CodemapToolError>({
      code: "NOT_FOUND",
    });
  });

  test("throws READ_DENIED for path traversal", async () => {
    await expect(
      executeCodemap(
        { paths: ["../../etc/passwd"] },
        {
          repoRoot: "/repo",
          repoFiles: ["src/a.ts"],
        },
      ),
    ).rejects.toMatchObject<CodemapToolError>({
      code: "READ_DENIED",
    });
  });

  test("uses parser fallback when codemap lookup is not provided", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ctx-codemap-tool-"));
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");

    let disposed = false;
    const parser = {
      parse: async () => ({
        language: "typescript",
        tree: null,
        parseError: false,
        warnings: [],
      }),
      dispose: () => {
        disposed = true;
      },
    } as unknown as TreeSitterCodemapParser;

    const payload = await executeCodemap(
      { paths: ["src/a.ts"], detail: "summary" },
      {
        repoRoot,
        repoFiles: ["src/a.ts"],
        readFileText: async () => "export const a = 1;\n",
        parserFactory: async () => parser,
      },
    );

    expect(payload.results).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        language: "typescript",
        symbols: [],
      }),
    ]);
    expect(disposed).toBe(true);
  });
});
