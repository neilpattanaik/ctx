import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SelectionManager } from "../../src/selection";
import {
  BudgetToolError,
  executeBudgetReport,
  executeTokenEstimate,
  validateBudgetReportArgs,
  validateTokenEstimateArgs,
  type BudgetToolsContext,
} from "../../src/tools/budget-tools";

function createSelectionManager(): SelectionManager {
  const manager = new SelectionManager({
    maxFiles: 20,
    maxFullFiles: 5,
    maxSlicesPerFile: 4,
    maxFileBytes: 1_500_000,
    neverInclude: [],
    excludeBinary: true,
  });

  manager.add({
    path: "src/full.ts",
    mode: "full",
    priority: "core",
    rationale: "full coverage",
  });
  manager.add({
    path: "src/slice.ts",
    mode: "slices",
    priority: "support",
    rationale: "slice coverage",
    slices: [
      {
        startLine: 2,
        endLine: 3,
        description: "focus area",
        rationale: "task match",
      },
    ],
  });
  manager.add({
    path: "src/codemap.ts",
    mode: "codemap_only",
    priority: "ref",
    rationale: "reference",
  });

  return manager;
}

function createContext(overrides: Partial<BudgetToolsContext> = {}): BudgetToolsContext {
  const repoRoot = "/repo";
  const files: Record<string, string> = {
    [resolve(repoRoot, "src/full.ts")]: "abcdefghij",
    [resolve(repoRoot, "src/slice.ts")]: "one\ntwo\nthree\nfour\n",
    [resolve(repoRoot, "src/codemap.ts")]: "codemap content",
  };

  return {
    repoRoot,
    selectionManager: createSelectionManager(),
    budgetTokens: 300,
    reserveTokens: 20,
    treeTokens: 10,
    metadataTokens: 5,
    diffTokens: 3,
    charsPerToken: 4,
    readFileText: (absolutePath) => {
      if (!(absolutePath in files)) {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return files[absolutePath]!;
    },
    ...overrides,
  };
}

describe("budget tool arg validation", () => {
  test("validates token_estimate arguments", () => {
    expect(validateTokenEstimateArgs({ text: "hello" })).toEqual({ ok: true });
    expect(validateTokenEstimateArgs({ path: "src/app.ts" })).toEqual({ ok: true });
    expect(validateTokenEstimateArgs({ selection: true })).toEqual({ ok: true });

    expect(validateTokenEstimateArgs(undefined)).toEqual({
      ok: false,
      message: "args must be an object",
    });
    expect(validateTokenEstimateArgs({ text: "a", path: "src/app.ts" })).toEqual({
      ok: false,
      message: "Provide exactly one of args.text, args.path, or args.selection=true",
    });
    expect(validateTokenEstimateArgs({ selection: false })).toEqual({
      ok: false,
      message: "args.selection must be true when provided",
    });
    expect(validateTokenEstimateArgs({ text: "a", chars_per_token: 0 })).toEqual({
      ok: false,
      message: "args.chars_per_token must be a finite number > 0",
    });
  });

  test("validates budget_report arguments", () => {
    expect(validateBudgetReportArgs(undefined)).toEqual({ ok: true });
    expect(validateBudgetReportArgs({})).toEqual({ ok: true });
    expect(validateBudgetReportArgs({ chars_per_token: 3.5 })).toEqual({ ok: true });

    expect(validateBudgetReportArgs("bad")).toEqual({
      ok: false,
      message: "args must be an object when provided",
    });
    expect(validateBudgetReportArgs({ extra: true })).toEqual({
      ok: false,
      message: "Unknown argument: extra",
    });
  });
});

describe("token_estimate execution", () => {
  test("estimates tokens for text, file path, and selection", () => {
    const context = createContext();

    const textResult = executeTokenEstimate({ text: "abcdefghij" }, context);
    expect(textResult).toEqual({
      tokens: 3,
      method: "char_ratio",
      ratio: 4,
      source: "text",
    });

    const pathResult = executeTokenEstimate({ path: "src/full.ts" }, context);
    expect(pathResult).toEqual({
      tokens: 3,
      method: "char_ratio",
      ratio: 4,
      source: "path",
    });

    const selectionResult = executeTokenEstimate({ selection: true }, context);
    expect(selectionResult).toEqual({
      tokens: 126,
      method: "char_ratio",
      ratio: 4,
      source: "selection",
    });
  });

  test("throws deterministic errors for missing paths", () => {
    const context = createContext();
    expect(() => executeTokenEstimate({ path: "src/missing.ts" }, context)).toThrow(
      BudgetToolError,
    );
    expect(() => executeTokenEstimate({ path: "src/missing.ts" }, context)).toThrow(
      "File does not exist: src/missing.ts",
    );
  });
});

describe("budget_report execution", () => {
  test("returns deterministic budget breakdown and constraints", () => {
    const context = createContext();
    const report = executeBudgetReport(undefined, context);

    expect(report).toEqual({
      budget: 280,
      estimated_total: 144,
      remaining: 136,
      breakdown: {
        files_full: { count: 1, tokens: 3 },
        files_slices: { count: 1, tokens: 3 },
        codemaps: { count: 1, tokens: 120 },
        tree: { tokens: 10 },
        metadata: { tokens: 5 },
        diff: { tokens: 3 },
      },
      constraints: {
        max_files: { limit: 20, used: 3 },
        max_full_files: { limit: 5, used: 1 },
      },
    });
  });
});
