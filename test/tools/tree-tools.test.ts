import { describe, expect, test } from "bun:test";
import {
  executeFileTree,
  validateFileTreeArgs,
} from "../../src/tools/tree-tools";

describe("file_tree arg validation", () => {
  test("validates mode/max_depth/path fields", () => {
    expect(validateFileTreeArgs(undefined)).toEqual({ ok: true });
    expect(validateFileTreeArgs({ mode: "auto", max_depth: 3, path: "src" })).toEqual({
      ok: true,
    });

    expect(validateFileTreeArgs("bad")).toEqual({
      ok: false,
      message: "args must be an object when provided",
    });

    expect(validateFileTreeArgs({ mode: "invalid" })).toEqual({
      ok: false,
      message: "args.mode must be one of: auto, full, folders, selected",
    });

    expect(validateFileTreeArgs({ max_depth: 0 })).toEqual({
      ok: false,
      message: "args.max_depth must be a positive integer",
    });

    expect(validateFileTreeArgs({ path: "" })).toEqual({
      ok: false,
      message: "args.path must be a non-empty string",
    });
  });
});

describe("executeFileTree", () => {
  test("renders full mode with deterministic directory-first ordering", () => {
    const result = executeFileTree(
      { mode: "full" },
      {
        repoFiles: ["src/z.ts", "src/a.ts", "docs/readme.md", "README.md"],
      },
    );

    expect(result.mode).toBe("full");
    expect(result.lines.map((line) => line.text)).toEqual([
      "docs/ [1 files]",
      "  readme.md",
      "src/ [2 files]",
      "  a.ts",
      "  z.ts",
      "README.md",
    ]);
    expect(result.truncation.truncated).toBe(false);
  });

  test("renders folders mode with file counts and no files", () => {
    const result = executeFileTree(
      { mode: "folders" },
      {
        repoFiles: ["src/a.ts", "src/lib/core.ts", "src/lib/nested/deep.ts"],
      },
    );

    expect(result.mode).toBe("folders");
    expect(result.max_depth).toBe(3);
    expect(result.lines.map((line) => line.text)).toEqual([
      "src/ [3 files]",
      "  lib/ [2 files]",
      "    nested/ [1 files]",
    ]);
  });

  test("auto mode resolves to full for small repos and folders for larger repos", () => {
    const small = executeFileTree(
      { mode: "auto" },
      {
        repoFiles: ["src/a.ts", "src/b.ts"],
        autoFullThreshold: 10,
      },
    );
    expect(small.mode).toBe("full");

    const large = executeFileTree(
      { mode: "auto" },
      {
        repoFiles: Array.from({ length: 20 }, (_value, index) => `src/file-${index}.ts`),
        autoFullThreshold: 10,
      },
    );
    expect(large.mode).toBe("folders");
  });

  test("selected mode only renders selected files and parent directories", () => {
    const result = executeFileTree(
      { mode: "selected" },
      {
        repoFiles: ["src/a.ts", "src/b.ts", "test/x.ts"],
        selectedPaths: ["src/b.ts", "missing.ts"],
      },
    );

    expect(result.mode).toBe("selected");
    expect(result.lines.map((line) => line.text)).toEqual([
      "src/ [1 files]",
      "  b.ts",
    ]);
  });

  test("path scopes output to a subtree", () => {
    const result = executeFileTree(
      {
        mode: "full",
        path: "src/lib",
      },
      {
        repoFiles: ["src/lib/a.ts", "src/lib/b.ts", "src/other.ts"],
      },
    );

    expect(result.path).toBe("src/lib");
    expect(result.lines.map((line) => line.text)).toEqual([
      "src/lib/ [2 files]",
      "  a.ts",
      "  b.ts",
    ]);
  });

  test("applies explicit max line truncation marker", () => {
    const result = executeFileTree(
      { mode: "full" },
      {
        repoFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
        maxLines: 3,
      },
    );

    expect(result.lines.map((line) => line.text)).toEqual([
      "a.ts",
      "b.ts",
      "... (2 more entries)",
    ]);
    expect(result.truncation).toEqual({
      truncated: true,
      max_lines: 3,
      omitted_entries: 2,
    });
  });
});
