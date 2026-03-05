import { describe, expect, test } from "bun:test";

import { SelectionManager } from "../../src/selection";
import type { SelectionEntry } from "../../src/types";

function baseEntry(
  path: string,
  mode: SelectionEntry["mode"],
  priority: SelectionEntry["priority"],
): SelectionEntry {
  if (mode === "slices") {
    return {
      path,
      mode,
      priority,
      rationale: "unit test",
      slices: [
        {
          startLine: 1,
          endLine: 5,
          description: "slice",
          rationale: "coverage",
        },
      ],
    };
  }

  return {
    path,
    mode,
    priority,
    rationale: "unit test",
  };
}

function createManager(overrides: Partial<ConstructorParameters<typeof SelectionManager>[0]> = {}) {
  return new SelectionManager({
    maxFiles: 10,
    maxFullFiles: 10,
    maxSlicesPerFile: 4,
    maxFileBytes: 1_500_000,
    neverInclude: [],
    excludeBinary: true,
    ...overrides,
  });
}

describe("SelectionManager", () => {
  test("stores and sorts entries deterministically by score then path", () => {
    const manager = createManager();

    const first = manager.add(baseEntry("src/b.ts", "full", "core"));
    const second = manager.add(baseEntry("src/a.ts", "full", "core"));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.getAll().map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("enforces maxFiles and maxFullFiles constraints", () => {
    const manager = createManager({
      maxFiles: 2,
      maxFullFiles: 1,
      maxSlicesPerFile: 2,
    });

    expect(manager.add(baseEntry("src/first.ts", "full", "core")).ok).toBe(true);
    const fullViolation = manager.add(baseEntry("src/second.ts", "full", "support"));
    expect(fullViolation.ok).toBe(false);
    if (!fullViolation.ok) {
      expect(fullViolation.error.code).toBe("MAX_FULL_FILES_EXCEEDED");
    }

    expect(manager.add(baseEntry("src/second.ts", "slices", "support")).ok).toBe(
      true,
    );

    const fileCountViolation = manager.add(
      baseEntry("src/third.ts", "codemap_only", "ref"),
    );
    expect(fileCountViolation.ok).toBe(false);
    if (!fileCountViolation.ok) {
      expect(fileCountViolation.error.code).toBe("MAX_FILES_EXCEEDED");
    }
  });

  test("enforces never-include and binary exclusion", () => {
    const manager = createManager({
      neverInclude: ["**/.env", "**/*secret*"],
    });

    const neverIncludeResult = manager.add(baseEntry(".env", "full", "core"));
    expect(neverIncludeResult.ok).toBe(false);
    if (!neverIncludeResult.ok) {
      expect(neverIncludeResult.error.code).toBe("NEVER_INCLUDE_MATCH");
    }

    const binaryResult = manager.add(baseEntry("assets/logo.png", "full", "core"), {
      isBinary: true,
    });
    expect(binaryResult.ok).toBe(false);
    if (!binaryResult.ok) {
      expect(binaryResult.error.code).toBe("BINARY_FILE_EXCLUDED");
    }
  });

  test("returns compact summary and full manifest", () => {
    const manager = createManager({
      neverInclude: ["**/.env"],
    });

    manager.add(baseEntry("src/index.ts", "full", "core"));
    manager.add(baseEntry("src/config.ts", "slices", "support"));
    manager.add(baseEntry("src/types.ts", "codemap_only", "ref"));

    const summary = manager.toSummary();
    expect(summary.totalFiles).toBe(3);
    expect(summary.byMode).toEqual({
      full: 1,
      slices: 1,
      codemap_only: 1,
    });
    expect(summary.byPriority).toEqual({
      core: 1,
      support: 1,
      ref: 1,
    });

    const manifest = manager.toManifest();
    expect(manifest.constraints.neverInclude).toEqual(["**/.env"]);
    expect(manifest.entries.length).toBe(3);
  });

  test("supports get/remove/clear update flow", () => {
    const manager = createManager();

    manager.add(baseEntry("src/index.ts", "full", "core"));
    expect(manager.get("src/index.ts")?.path).toBe("src/index.ts");
    expect(manager.remove("src/index.ts")).toBe(true);
    expect(manager.get("src/index.ts")).toBeUndefined();

    manager.add(baseEntry("src/a.ts", "full", "core"));
    manager.add(baseEntry("src/b.ts", "slices", "support"));
    expect(manager.getAll()).toHaveLength(2);
    manager.clear();
    expect(manager.getAll()).toHaveLength(0);
  });

  test("enforceHardConstraints deterministically degrades, merges, and drops", () => {
    const manager = createManager({
      maxFiles: 10,
      maxFullFiles: 10,
      maxSlicesPerFile: 10,
    });

    manager.add(baseEntry("src/core.ts", "full", "core"));
    manager.add(baseEntry("src/support.ts", "full", "support"));
    manager.add(
      {
        path: "src/ref.ts",
        mode: "slices",
        priority: "ref",
        rationale: "unit test",
        slices: [
          { startLine: 1, endLine: 2, description: "a", rationale: "a" },
          { startLine: 4, endLine: 5, description: "b", rationale: "b" },
          { startLine: 6, endLine: 9, description: "c", rationale: "c" },
        ],
      },
      { priorityScore: 50 },
    );

    (manager as unknown as { options: { maxFiles: number; maxFullFiles: number; maxSlicesPerFile: number } }).options.maxFiles = 2;
    (manager as unknown as { options: { maxFiles: number; maxFullFiles: number; maxSlicesPerFile: number } }).options.maxFullFiles = 1;
    (manager as unknown as { options: { maxFiles: number; maxFullFiles: number; maxSlicesPerFile: number } }).options.maxSlicesPerFile = 2;

    const result = manager.enforceHardConstraints();

    expect(result.actions.some((action) => action.type === "degrade_full_to_slices")).toBe(
      true,
    );
    expect(result.actions.some((action) => action.type === "merge_slices")).toBe(true);
    expect(result.actions.some((action) => action.type === "drop")).toBe(true);

    expect(result.entries.length).toBe(2);
    expect(result.entries.filter((entry) => entry.mode === "full").length).toBeLessThanOrEqual(1);
  });

  test("enforceHardConstraints drops never-include and oversized entries", () => {
    const manager = createManager({
      neverInclude: ["**/.env"],
      maxFileBytes: 5,
    });

    manager.add(baseEntry("src/index.ts", "full", "core"));
    manager.add(baseEntry(".env", "codemap_only", "ref"), { fileBytes: 4 });
    manager.add(baseEntry("src/large.ts", "codemap_only", "ref"), { fileBytes: 10 });

    const result = manager.enforceHardConstraints();
    expect(result.entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });
});
