import { describe, expect, test } from "bun:test";

import {
  SelectionManager,
  applyDeterministicBudgetDegradation,
  computeSelectionPriorityScores,
  constructAstAwareSlices,
  runBudgetNormalizationLoop,
} from "../../src/selection";
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

  test("computes deterministic weighted priority scores from all signal classes", () => {
    const entries: SelectionEntry[] = [
      baseEntry("src/main.ts", "full", "core"),
      baseEntry("src/auth/service.ts", "slices", "support"),
      baseEntry("src/utils.ts", "codemap_only", "ref"),
    ];

    const scores = computeSelectionPriorityScores(entries, {
      explicitIncludePaths: ["src/main.ts"],
      explicitEntrypointPaths: [],
      taskText: "Investigate auth flow in src/auth/service.ts with cache fallback",
      reviewMode: true,
      gitChangedPaths: ["src/auth/service.ts", "src/utils.ts"],
      hitCountsByPath: {
        "src/main.ts": 2,
        "src/auth/service.ts": 5,
        "src/utils.ts": 1,
      },
      importHopsByPath: {
        "src/main.ts": 0,
        "src/auth/service.ts": 1,
        "src/utils.ts": 3,
      },
    });

    expect(scores["src/main.ts"]).toBe(1580);
    expect(scores["src/auth/service.ts"]).toBe(1200);
    expect(scores["src/utils.ts"]).toBe(477);
  });

  test("uses review-mode specific git weight", () => {
    const entries: SelectionEntry[] = [baseEntry("src/auth.ts", "full", "support")];

    const reviewScore = computeSelectionPriorityScores(entries, {
      reviewMode: true,
      gitChangedPaths: ["src/auth.ts"],
    });
    const normalScore = computeSelectionPriorityScores(entries, {
      reviewMode: false,
      gitChangedPaths: ["src/auth.ts"],
    });

    expect(reviewScore["src/auth.ts"]).toBe(425);
    expect(normalScore["src/auth.ts"]).toBe(125);
  });

  test("finalizePriorityScores stamps scores once and keeps lexical tie-breaks", () => {
    const manager = createManager();
    manager.add(baseEntry("z-feature.ts", "full", "support"));
    manager.add(baseEntry("a-feature.ts", "full", "support"));

    const finalized = manager.finalizePriorityScores({
      hitCountsByPath: {
        "z-feature.ts": 4,
        "a-feature.ts": 4,
      },
      importHopsByPath: {
        "z-feature.ts": 2,
        "a-feature.ts": 2,
      },
    });

    expect(finalized.map((entry) => entry.path)).toEqual([
      "a-feature.ts",
      "z-feature.ts",
    ]);
    expect(finalized[0]?.priorityScore).toBe(finalized[1]?.priorityScore);
    expect(finalized[0]?.priorityScore).toBe(275);
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
    expect(manager.toManifest().neverIncludeExcludedPaths).toEqual([".env"]);

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
    expect(manifest.neverIncludeExcludedPaths).toEqual([]);
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
      neverInclude: [],
      maxFileBytes: 5,
    });

    manager.add(baseEntry("src/index.ts", "full", "core"));
    manager.add(baseEntry(".env", "codemap_only", "ref"), { fileBytes: 4 });
    manager.add(baseEntry("src/large.ts", "codemap_only", "ref"), { fileBytes: 10 });
    (manager as unknown as { options: { neverInclude: string[] } }).options.neverInclude = [
      "**/.env",
    ];

    const result = manager.enforceHardConstraints();
    expect(result.entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
    expect(manager.toManifest().neverIncludeExcludedPaths).toEqual([".env"]);
  });

  test("constructs AST-aware slices by expanding provided ranges to enclosing symbol boundaries", () => {
    const content = [
      "const prelude = true;",
      "function loginHandler(req) {",
      "  const token = req.token;",
      "  return token;",
      "}",
      "function other() { return 1; }",
    ].join("\n");

    const slices = constructAstAwareSlices({
      path: "src/auth.ts",
      content,
      providedSlices: [
        {
          startLine: 3,
          endLine: 3,
          description: "agent hint",
          rationale: "agent-selected",
        },
      ],
      symbols: [
        {
          kind: "function",
          signature: "function loginHandler(req) {",
          line: 2,
          endLine: 5,
        },
      ],
      maxSlicesPerFile: 4,
    });

    expect(slices).toEqual([
      expect.objectContaining({
        startLine: 2,
        endLine: 5,
      }),
    ]);
    expect(slices[0]?.description).toContain("enclosing symbol");
    expect(slices[0]?.rationale).toContain("expanded to enclosing symbol boundary");
  });

  test("constructs task-term slices with fallback windows when symbols are unavailable", () => {
    const content = Array.from({ length: 80 }, (_, index) =>
      index === 39 ? "critical token refresh logic" : `line ${index + 1}`,
    ).join("\n");

    const slices = constructAstAwareSlices({
      path: "src/refresh.ts",
      content,
      taskTerms: ["token", "refresh"],
      fallbackContextLines: 10,
      maxSlicesPerFile: 4,
    });

    expect(slices).toEqual([
      expect.objectContaining({
        startLine: 30,
        endLine: 50,
      }),
    ]);
    expect(slices[0]?.description).toContain("task-relevant context");
  });

  test("uses AST-aware seeded slices during full->slices budget degradation", () => {
    const manager = createManager();
    manager.add(baseEntry("src/auth.ts", "full", "core"), { priorityScore: 300 });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 120,
      entries: manager.getAll(),
      maxSlicesPerFile: 4,
      sliceSeedsByPath: {
        "src/auth.ts": {
          content: [
            "const x = 1;",
            "function loginHandler(req) {",
            "  const token = req.token;",
            "  return token;",
            "}",
          ].join("\n"),
          taskTerms: ["token"],
          symbols: [
            {
              kind: "function",
              signature: "function loginHandler(req) {",
              line: 2,
              endLine: 5,
            },
          ],
        },
      },
      estimateTokens: (state) => {
        let total = 100;
        for (const entry of state.entries) {
          if (entry.mode === "full") {
            total += 100;
          } else if (entry.mode === "slices") {
            total += 20;
          }
        }
        return total;
      },
    });

    const degraded = result.state.entries.find((entry) => entry.path === "src/auth.ts");
    expect(degraded?.mode).toBe("slices");
    if (degraded?.mode === "slices") {
      expect(degraded.slices).toEqual([
        expect.objectContaining({
          startLine: 2,
          endLine: 5,
        }),
      ]);
    }
  });

  test("applies deterministic budget degradation order and stops when within budget", () => {
    const manager = createManager();
    manager.add(baseEntry("src/core.ts", "full", "core"), { priorityScore: 300 });
    manager.add(baseEntry("src/support.ts", "full", "support"), { priorityScore: 200 });
    manager.add(baseEntry("src/slices.ts", "slices", "ref"), { priorityScore: 100 });
    manager.add(baseEntry("src/codemap.ts", "codemap_only", "ref"), {
      priorityScore: 90,
    });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 350,
      entries: manager.getAll(),
      estimateTokens: (state) => {
        const treeTokens =
          state.treeVerbosity === "full" ? 50 : state.treeVerbosity === "selected" ? 20 : 0;
        let total = treeTokens + state.sliceContextLines;

        for (const entry of state.entries) {
          if (entry.mode === "full") total += 100;
          if (entry.mode === "slices") total += 60;
          if (entry.mode === "codemap_only") total += 30;
        }

        for (const detail of Object.values(state.codemapDetailByPath)) {
          total += detail === "complete" ? 15 : 5;
        }

        return total;
      },
    });

    expect(result.overBudget).toBe(false);
    expect(result.degradations.map((item) => item.step)).toEqual([
      "full_to_slices",
      "full_to_slices",
    ]);
    expect(result.degradations.map((item) => item.reason)).toEqual([
      "degrade src/support.ts full->slices",
      "degrade src/core.ts full->slices",
    ]);
    expect(result.estimatedTokens).toBe(350);
    expect(result.state.entries.find((entry) => entry.path === "src/core.ts")?.mode).toBe(
      "slices",
    );
    expect(result.state.entries.find((entry) => entry.path === "src/support.ts")?.mode).toBe(
      "slices",
    );
  });

  test("runs full deterministic ladder and reports fail-on-overbudget state", () => {
    const manager = createManager();
    manager.add(baseEntry("a-full.ts", "full", "support"), { priorityScore: 100 });
    manager.add(baseEntry("b-slices.ts", "slices", "support"), { priorityScore: 90 });
    manager.add(baseEntry("c-codemap.ts", "codemap_only", "ref"), { priorityScore: 80 });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 80,
      entries: manager.getAll(),
      failOnOverbudget: true,
      estimateTokens: (state) => {
        const treeTokens =
          state.treeVerbosity === "full"
            ? 40
            : state.treeVerbosity === "selected"
              ? 20
              : 10;

        let total = 120 + treeTokens + state.sliceContextLines * 2;
        for (const entry of state.entries) {
          if (entry.mode === "full") total += 120;
          if (entry.mode === "slices") total += 90;
          if (entry.mode === "codemap_only") total += 60;
        }
        for (const detail of Object.values(state.codemapDetailByPath)) {
          total += detail === "complete" ? 20 : 5;
        }
        return total;
      },
    });

    expect(result.degradations.map((item) => item.step)).toEqual([
      "full_to_slices",
      "slices_to_codemap_only",
      "slices_to_codemap_only",
      "drop_codemap_only",
      "drop_codemap_only",
      "drop_codemap_only",
      "codemap_complete_to_summary",
      "codemap_complete_to_summary",
      "codemap_complete_to_summary",
      "shrink_slice_windows",
      "shrink_slice_windows",
      "reduce_tree_verbosity",
      "reduce_tree_verbosity",
    ]);
    expect(result.overBudget).toBe(true);
    expect(result.shouldFail).toBe(true);
    expect(result.warning).toContain("exceed budget");
    expect(result.state.treeVerbosity).toBe("none");
    expect(result.state.sliceContextLines).toBe(10);
  });

  test("degrades same-priority files by lexicographic path order", () => {
    const manager = createManager();
    manager.add(baseEntry("z-last.ts", "full", "support"), { priorityScore: 100 });
    manager.add(baseEntry("a-first.ts", "full", "support"), { priorityScore: 100 });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 10,
      entries: manager.getAll(),
      estimateTokens: (state) => {
        let total = 200;
        for (const entry of state.entries) {
          if (entry.mode === "full") total += 100;
          if (entry.mode === "slices") total += 60;
          if (entry.mode === "codemap_only") total += 40;
        }
        return total;
      },
    });

    expect(result.degradations[0]?.reason).toContain("a-first.ts");
    expect(result.degradations[1]?.reason).toContain("z-last.ts");
  });

  test("normalizes budget with section/file estimates and reserve tokens", () => {
    const manager = createManager();
    manager.add(baseEntry("src/core.ts", "full", "core"), { priorityScore: 300 });
    manager.add(baseEntry("src/support.ts", "slices", "support"), { priorityScore: 200 });
    manager.add(baseEntry("src/ref.ts", "codemap_only", "ref"), { priorityScore: 100 });

    const result = runBudgetNormalizationLoop({
      budgetTokens: 500,
      reserveTokens: 100,
      entries: manager.getAll(),
      estimateBreakdown: (state) => {
        const byFile: Record<string, number> = {};
        for (const entry of state.entries) {
          if (entry.mode === "full") byFile[entry.path] = 180;
          if (entry.mode === "slices") byFile[entry.path] = 110;
          if (entry.mode === "codemap_only") byFile[entry.path] = 70;
        }

        const codemapTokens = Object.values(state.codemapDetailByPath).reduce(
          (sum, detail) => sum + (detail === "complete" ? 20 : 10),
          0,
        );
        const treeTokens =
          state.treeVerbosity === "full" ? 40 : state.treeVerbosity === "selected" ? 20 : 8;

        return {
          bySection: {
            files: Object.values(byFile).reduce((sum, value) => sum + value, 0),
            codemaps: codemapTokens,
            tree: treeTokens,
            metadata: 30,
            diff: 0,
          },
          byFile,
        };
      },
    });

    expect(result.report.budget).toBe(500);
    expect(result.report.effectiveBudget).toBe(400);
    expect(result.report.initialEstimate).toBeGreaterThan(400);
    expect(result.report.finalEstimate).toBeLessThanOrEqual(400);
    expect(result.report.overBudget).toBe(false);
    expect(result.report.shouldFail).toBe(false);
    expect(result.report.bySection.files).toBeGreaterThan(0);
    expect(Object.keys(result.report.byFile)).toContain("src/core.ts");
    expect(result.report.degradations.length).toBeGreaterThan(0);
    expect(result.report.degradations[0]?.action).toBe("full_to_slices");
  });

  test("emits structured degradation entries and fail signal when still over budget", () => {
    const manager = createManager();
    manager.add(baseEntry("a.ts", "full", "support"), { priorityScore: 100 });
    manager.add(baseEntry("b.ts", "slices", "support"), { priorityScore: 90 });

    const result = runBudgetNormalizationLoop({
      budgetTokens: 50,
      entries: manager.getAll(),
      failOnOverbudget: true,
      estimateBreakdown: (state) => {
        let files = 0;
        for (const entry of state.entries) {
          if (entry.mode === "full") files += 180;
          if (entry.mode === "slices") files += 120;
          if (entry.mode === "codemap_only") files += 80;
        }
        const codemaps = Object.values(state.codemapDetailByPath).reduce(
          (sum, detail) => sum + (detail === "complete" ? 30 : 15),
          0,
        );
        const tree =
          state.treeVerbosity === "full"
            ? 40
            : state.treeVerbosity === "selected"
              ? 20
              : 10;
        return {
          bySection: {
            files,
            codemaps,
            tree,
            metadata: 120,
          },
          byFile: {
            "a.ts": 180,
            "b.ts": 120,
          },
        };
      },
    });

    expect(result.report.overBudget).toBe(true);
    expect(result.report.shouldFail).toBe(true);
    expect(result.report.warning).toContain("exceed");
    expect(result.report.degradations[0]).toMatchObject({
      action: "full_to_slices",
      targetPath: "a.ts",
      fromMode: "full",
      toMode: "slices",
    });
    expect(result.report.degradations.every((item) => item.tokensSaved >= 0)).toBe(true);
  });

  test("degradation report mirrors actual deterministic actions and token deltas", () => {
    const manager = createManager();
    manager.add(baseEntry("src/report.ts", "full", "core"), { priorityScore: 500 });

    const result = runBudgetNormalizationLoop({
      budgetTokens: 80,
      entries: manager.getAll(),
      estimateBreakdown: (state) => {
        const byFile: Record<string, number> = {};
        for (const entry of state.entries) {
          if (entry.mode === "full") byFile[entry.path] = 300;
          if (entry.mode === "slices") byFile[entry.path] = 150;
          if (entry.mode === "codemap_only") byFile[entry.path] = 80;
        }
        return {
          bySection: {
            files: Object.values(byFile).reduce((sum, value) => sum + value, 0),
            codemaps: 0,
            tree: 0,
            metadata: 0,
          },
          byFile,
        };
      },
    });

    expect(result.report.degradations).toEqual([
      {
        action: "full_to_slices",
        targetPath: "src/report.ts",
        fromMode: "full",
        toMode: "slices",
        tokensSaved: 150,
      },
      {
        action: "slices_to_codemap_only",
        targetPath: "src/report.ts",
        fromMode: "slices",
        toMode: "codemap_only",
        tokensSaved: 70,
      },
    ]);
    expect(result.report.finalEstimate).toBe(80);
    expect(result.state.entries).toEqual([
      expect.objectContaining({
        path: "src/report.ts",
        mode: "codemap_only",
      }),
    ]);
  });

  test("keeps all 50 selected files when budget is ample", () => {
    const manager = createManager({
      maxFiles: 80,
      maxFullFiles: 80,
    });

    for (let index = 0; index < 50; index += 1) {
      const path = `src/file-${String(index).padStart(3, "0")}.ts`;
      manager.add(baseEntry(path, "full", "support"), {
        priorityScore: 100 + index,
      });
    }

    const initialEntries = manager.getAll();
    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 60_000,
      entries: initialEntries,
      estimateTokens: (state) =>
        state.entries.reduce((sum, entry) => sum + (entry.mode === "full" ? 200 : 0), 0),
    });

    expect(result.degradations).toHaveLength(0);
    expect(result.overBudget).toBe(false);
    expect(result.state.entries).toHaveLength(50);
    expect(result.state.entries.every((entry) => entry.mode === "full")).toBe(true);
  });

  test("runs heavy degradation ladder over 50 files in deterministic step order", () => {
    const manager = createManager({
      maxFiles: 80,
      maxFullFiles: 80,
    });

    for (let index = 0; index < 50; index += 1) {
      const path = `src/heavy-${String(index).padStart(3, "0")}.ts`;
      manager.add(baseEntry(path, "full", "support"), {
        priorityScore: 100,
      });
    }

    const estimateTokens = (entries: readonly { mode: SelectionEntry["mode"] }[]) =>
      entries.reduce((sum, entry) => {
        if (entry.mode === "full") return sum + 500;
        if (entry.mode === "slices") return sum + 400;
        return sum + 300;
      }, 0);

    const first = applyDeterministicBudgetDegradation({
      budgetTokens: 10_000,
      entries: manager.getAll(),
      estimateTokens: (state) => estimateTokens(state.entries),
    });
    const second = applyDeterministicBudgetDegradation({
      budgetTokens: 10_000,
      entries: manager.getAll(),
      estimateTokens: (state) => estimateTokens(state.entries),
    });

    const steps = first.degradations.map((item) => item.step);
    expect(steps.slice(0, 50).every((step) => step === "full_to_slices")).toBe(true);
    expect(steps.slice(50, 100).every((step) => step === "slices_to_codemap_only")).toBe(
      true,
    );
    expect(steps.slice(100).every((step) => step === "drop_codemap_only")).toBe(true);

    expect(first.degradations).toEqual(second.degradations);
    expect(first.degradations[0]?.reason).toContain("src/heavy-000.ts");
    expect(first.overBudget).toBe(false);
    expect(first.state.entries.length).toBeLessThan(50);
  });

  test("does not degrade when estimate is exactly at budget boundary", () => {
    const manager = createManager({
      maxFiles: 20,
      maxFullFiles: 20,
    });
    manager.add(baseEntry("src/boundary-a.ts", "full", "core"), { priorityScore: 300 });
    manager.add(baseEntry("src/boundary-b.ts", "slices", "support"), { priorityScore: 200 });
    manager.add(baseEntry("src/boundary-c.ts", "codemap_only", "ref"), {
      priorityScore: 100,
    });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 400,
      entries: manager.getAll(),
      estimateTokens: (state) =>
        state.entries.reduce((sum, entry) => {
          if (entry.mode === "full") return sum + 200;
          if (entry.mode === "slices") return sum + 120;
          return sum + 80;
        }, 0),
    });

    expect(result.estimatedTokens).toBe(400);
    expect(result.degradations).toHaveLength(0);
    expect(result.overBudget).toBe(false);
  });

  test("degrades a single huge file full->slices->codemap_only until it fits", () => {
    const manager = createManager({
      maxFiles: 10,
      maxFullFiles: 10,
    });
    manager.add(baseEntry("src/huge.ts", "full", "core"), { priorityScore: 999 });

    const result = applyDeterministicBudgetDegradation({
      budgetTokens: 250,
      entries: manager.getAll(),
      estimateTokens: (state) =>
        state.entries.reduce((sum, entry) => {
          if (entry.mode === "full") return sum + 1000;
          if (entry.mode === "slices") return sum + 400;
          return sum + 200;
        }, 0),
    });

    expect(result.degradations.map((item) => item.step)).toEqual([
      "full_to_slices",
      "slices_to_codemap_only",
    ]);
    expect(result.overBudget).toBe(false);
    expect(result.state.entries).toEqual([
      expect.objectContaining({
        path: "src/huge.ts",
        mode: "codemap_only",
      }),
    ]);
  });
});
