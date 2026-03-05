import { describe, expect, test } from "bun:test";

import {
  createRunRecord,
  createSelectionEntry,
  createSliceRange,
  createToolCall,
  createToolResultErr,
  createToolResultOk,
  type CtxConfig,
  type DiscoveryResult,
  type RunRecord,
  type TokenReport,
} from "../../src/types";

function sampleConfig(): CtxConfig {
  return {
    defaults: {
      mode: "plan",
      format: "markdown+xmltags",
      budgetTokens: 60_000,
      reserveTokens: 15_000,
      treeMode: "auto",
      codemaps: "auto",
      maxFiles: 80,
      maxFullFiles: 10,
      maxSlicesPerFile: 4,
      lineNumbers: true,
    },
    repo: {
      root: ".",
      useGitignore: true,
      ignore: [],
      maxFileBytes: 1_500_000,
      skipBinary: true,
    },
    index: {
      enabled: true,
      engine: "sqlite",
      rebuildOnSchemaChange: true,
    },
    discovery: {
      discover: "offline",
      provider: "openai",
      model: "",
      timeoutSeconds: 600,
      maxTurns: 20,
    },
    localCli: {
      agentPriority: ["codex-cli"],
      codexCliCommand: "codex",
      claudeCliCommand: "claude",
      geminiCliCommand: "gemini",
    },
    git: {
      diff: "off",
      gitStatus: true,
      maxFiles: 20,
      maxPatchTokens: 6000,
    },
    privacy: {
      mode: "normal",
      redact: true,
      neverInclude: [],
      extraRedactPatterns: [],
    },
    output: {
      includeManifestFooter: true,
      includeTokenReport: true,
      pathDisplay: "relative",
      storeRuns: true,
      runsDir: ".ctx/runs",
    },
  };
}

function sampleDiscovery(): DiscoveryResult {
  return {
    openQuestions: [],
    handoffSummary: {
      entrypoints: [],
      keyModules: [],
      dataFlows: [],
      configKnobs: [],
      tests: [],
    },
    selection: [],
  };
}

function sampleTokenReport(): TokenReport {
  return {
    budget: 60_000,
    estimated: 1200,
    bySection: {
      files: 1000,
      metadata: 200,
    },
    byFile: {
      "src/index.ts": 1000,
    },
    degradations: [],
  };
}

function sampleRunRecord(): RunRecord {
  return {
    runId: "run-123",
    task: "Sample task",
    config: sampleConfig(),
    discovery: sampleDiscovery(),
    selection: [],
    tokenReport: sampleTokenReport(),
    timing: {
      startedAt: "2026-03-05T00:00:00.000Z",
      finishedAt: "2026-03-05T00:00:02.000Z",
      durationMs: 2000,
      phaseDurationsMs: {
        scan: 800,
        discovery: 1200,
      },
    },
  };
}

describe("shared type contract factories", () => {
  test("createSliceRange validates and clones slice ranges", () => {
    const slice = createSliceRange({
      startLine: 10,
      endLine: 25,
      description: "handler",
      rationale: "task hit",
    });

    expect(slice).toEqual({
      startLine: 10,
      endLine: 25,
      description: "handler",
      rationale: "task hit",
    });
    expect(() =>
      createSliceRange({
        startLine: 20,
        endLine: 10,
        description: "bad",
        rationale: "bad",
      }),
    ).toThrow();
  });

  test("createSelectionEntry enforces slices mode invariants", () => {
    const entry = createSelectionEntry({
      path: "src/index.ts",
      mode: "slices",
      priority: "core",
      rationale: "high hit density",
      slices: [
        { startLine: 1, endLine: 12, description: "entrypoint", rationale: "io" },
      ],
    });

    expect(entry.mode).toBe("slices");
    if (entry.mode === "slices") {
      expect(entry.slices.length).toBe(1);
      expect(entry.slices[0]).toEqual({
        startLine: 1,
        endLine: 12,
        description: "entrypoint",
        rationale: "io",
      });
    }

    expect(() =>
      createSelectionEntry({
        path: "src/index.ts",
        mode: "slices",
        priority: "core",
        rationale: "empty",
        slices: [],
      }),
    ).toThrow();
  });

  test("tool call/result factories create expected envelopes", () => {
    const call = createToolCall("t1", "file_search", { pattern: "ctx" });
    const okResult = createToolResultOk("t1", { hits: 3 });
    const errResult = createToolResultErr("t2", {
      code: "READ_DENIED",
      message: "permission denied",
    });

    expect(call).toEqual({ id: "t1", tool: "file_search", args: { pattern: "ctx" } });
    expect(okResult.ok).toBe(true);
    expect(errResult.ok).toBe(false);
  });

  test("createRunRecord validates required fields", () => {
    const record = createRunRecord(sampleRunRecord());
    expect(record.runId).toBe("run-123");
    expect(() => createRunRecord({ ...record, runId: "" })).toThrow();
    expect(() =>
      createRunRecord({
        ...record,
        timing: { ...record.timing, durationMs: -1 },
      }),
    ).toThrow();
  });
});
