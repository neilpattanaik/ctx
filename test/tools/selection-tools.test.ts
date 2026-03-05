import { describe, expect, test } from "bun:test";
import { SelectionManager } from "../../src/selection";
import {
  SelectionToolError,
  executeSelectAdd,
  executeSelectClear,
  executeSelectGet,
  executeSelectRemove,
  validateSelectAddArgs,
  validateSelectGetArgs,
  validateSelectRemoveArgs,
} from "../../src/tools/selection-tools";

function createManager() {
  return new SelectionManager({
    maxFiles: 10,
    maxFullFiles: 5,
    maxSlicesPerFile: 4,
    maxFileBytes: 1_500_000,
    neverInclude: [],
    excludeBinary: true,
  });
}

describe("selection tool arg validation", () => {
  test("validates select_add args", () => {
    expect(
      validateSelectAddArgs({
        path: "src/app.ts",
        mode: "full",
      }),
    ).toEqual({ ok: true });

    expect(validateSelectAddArgs({ path: "", mode: "full" })).toEqual({
      ok: false,
      message: "args.path must be a non-empty string",
    });

    expect(validateSelectAddArgs({ path: "src/a.ts", mode: "invalid" })).toEqual({
      ok: false,
      message: "args.mode must be one of: full, slices, codemap_only",
    });

    expect(validateSelectAddArgs({ path: "src/a.ts", mode: "slices" })).toEqual({
      ok: false,
      message: "args.slices must be a non-empty array when args.mode='slices'",
    });
  });

  test("validates select_remove/select_get args", () => {
    expect(validateSelectRemoveArgs({ path: "src/a.ts" })).toEqual({ ok: true });
    expect(validateSelectRemoveArgs({ path: "" })).toEqual({
      ok: false,
      message: "args.path must be a non-empty string",
    });

    expect(validateSelectGetArgs(undefined)).toEqual({ ok: true });
    expect(validateSelectGetArgs({ view: "summary" })).toEqual({ ok: true });
    expect(validateSelectGetArgs({ view: "weird" })).toEqual({
      ok: false,
      message: "args.view must be one of: summary, files, content, codemaps",
    });
  });
});

describe("selection tool execution", () => {
  test("adds, lists, removes, and clears selection entries", () => {
    const manager = createManager();
    const context = {
      repoRoot: process.cwd(),
      repoFiles: ["src/a.ts", "src/b.ts"],
      selectionManager: manager,
      fileMetadataByPath: {
        "src/a.ts": { size: 350 },
        "src/b.ts": { size: 700 },
      },
    };

    const addResult = executeSelectAdd(
      {
        path: "src/a.ts",
        mode: "full",
        priority: "core",
        rationale: "important",
      },
      context,
    );
    expect(addResult.added).toBe("src/a.ts");
    expect(addResult.entry.path).toBe("src/a.ts");

    executeSelectAdd(
      {
        path: "src/b.ts",
        mode: "slices",
        slices: [
          {
            startLine: 10,
            endLine: 20,
            description: "focus",
            rationale: "unit test",
          },
        ],
      },
      context,
    );

    const summary = executeSelectGet({ view: "summary" }, context);
    expect(summary).toMatchObject({
      view: "summary",
      total_files: 2,
      by_mode: {
        full: 1,
        slices: 1,
        codemap_only: 0,
      },
    });

    const filesView = executeSelectGet({ view: "files" }, context);
    expect(filesView).toMatchObject({
      view: "files",
    });
    expect((filesView.files as Array<unknown>).length).toBe(2);

    const contentView = executeSelectGet({ view: "content" }, context);
    expect(contentView).toMatchObject({
      view: "content",
    });
    expect(contentView.total_estimated_tokens).toBeGreaterThan(0);

    const removeResult = executeSelectRemove({ path: "src/a.ts" }, context);
    expect(removeResult).toEqual({ removed: "src/a.ts" });

    const clearResult = executeSelectClear(context);
    expect(clearResult).toEqual({ cleared: 1 });
    expect(manager.getAll()).toHaveLength(0);
  });

  test("throws NOT_FOUND when add/remove paths are unknown", () => {
    const manager = createManager();
    const context = {
      repoRoot: process.cwd(),
      repoFiles: ["src/a.ts"],
      selectionManager: manager,
    };

    expect(() =>
      executeSelectAdd(
        {
          path: "src/missing.ts",
          mode: "full",
        },
        context,
      ),
    ).toThrowError(
      new SelectionToolError(
        "NOT_FOUND",
        "Path is not present in scanned repository files: src/missing.ts",
      ),
    );

    expect(() =>
      executeSelectRemove(
        {
          path: "src/a.ts",
        },
        context,
      ),
    ).toThrowError(
      new SelectionToolError("NOT_FOUND", "Selection does not include: src/a.ts"),
    );
  });

  test("returns codemap view for codemap_only entries via lookup", () => {
    const manager = createManager();
    const context = {
      repoRoot: process.cwd(),
      repoFiles: ["src/a.ts", "src/b.ts"],
      selectionManager: manager,
      codemapLookup: (paths: readonly string[]) =>
        paths.map((path) => ({
          path,
          language: "typescript",
          lines: 10,
          symbols: [],
        })),
    };

    executeSelectAdd(
      {
        path: "src/a.ts",
        mode: "codemap_only",
      },
      context,
    );
    executeSelectAdd(
      {
        path: "src/b.ts",
        mode: "full",
      },
      context,
    );

    const codemapView = executeSelectGet({ view: "codemaps" }, context);
    expect(codemapView).toEqual({
      view: "codemaps",
      paths: ["src/a.ts"],
      codemaps: [
        {
          path: "src/a.ts",
          language: "typescript",
          lines: 10,
          symbols: [],
        },
      ],
    });
  });
});
