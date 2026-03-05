import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createDeterministicRunId,
  persistRunArtifacts,
  readLatestRunId,
  type StoredRunRecord,
} from "../../src/artifacts";
import type { CtxConfig, DiscoveryResult, TokenReport } from "../../src/types";

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

function sampleRunRecord(runId: string): StoredRunRecord {
  return {
    runId,
    task: "Sample task",
    normalizedTerms: ["sample", "task"],
    discoveryBackend: "offline",
    discoveryDurationMs: 120,
    toolCallLog: [],
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

describe("run artifact storage", () => {
  test("creates deterministic run IDs", () => {
    const runId = createDeterministicRunId(
      "/tmp/repo",
      new Date("2024-01-15T14:30:22Z"),
    );
    expect(runId).toBe("20240115T143022-b6fe87a9");
  });

  test("skips persistence when storeRuns is disabled", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-disabled-`);
    const result = await persistRunArtifacts({
      repoRoot,
      runsDir: ".ctx/runs",
      storeRuns: false,
      runRecord: sampleRunRecord("run-disabled"),
      promptText: "prompt text",
    });

    expect(result.persisted).toBe(false);
    expect(result.runDirectory).toBe(resolve(repoRoot, ".ctx/runs/run-disabled"));
    const latest = await readLatestRunId(repoRoot, ".ctx/runs");
    expect(latest).toBeNull();
  });

  test("persists run.json/prompt.md and updates latest symlink", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-enabled-`);

    const first = await persistRunArtifacts({
      repoRoot,
      runsDir: ".ctx/runs",
      storeRuns: true,
      runRecord: sampleRunRecord("run-001"),
      promptText: "# Prompt 1\n",
    });

    expect(first.persisted).toBe(true);
    const runJson = JSON.parse(await readFile(first.runRecordPath, "utf8")) as {
      runId: string;
      normalizedTerms: string[];
    };
    expect(runJson.runId).toBe("run-001");
    expect(runJson.normalizedTerms).toEqual(["sample", "task"]);
    expect(await readFile(first.promptPath as string, "utf8")).toBe("# Prompt 1\n");

    const latestStat = await lstat(first.latestPath);
    expect(latestStat.isSymbolicLink()).toBe(true);
    const latestFallbackPath = resolve(repoRoot, ".ctx/runs/latest-run-id");
    expect(await readFile(latestFallbackPath, "utf8")).toBe("run-001\n");
    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBe("run-001");

    const second = await persistRunArtifacts({
      repoRoot,
      runsDir: ".ctx/runs",
      storeRuns: true,
      runRecord: sampleRunRecord("run-002"),
      promptText: "# Prompt 2\n",
    });

    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBe("run-002");
    expect(await readFile(latestFallbackPath, "utf8")).toBe("run-002\n");
    expect(second.runDirectory).toBe(resolve(repoRoot, ".ctx/runs/run-002"));
    expect(await readFile(second.promptPath as string, "utf8")).toBe("# Prompt 2\n");
  });

  test("reads latest run id from fallback file pointer", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-latest-file-`);
    const runsRoot = resolve(repoRoot, ".ctx/runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(resolve(runsRoot, "latest-run-id"), "run-file-pointer\n", "utf8");

    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBe("run-file-pointer");
  });

  test("prefers latest-run-id over legacy latest pointer file when both exist", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-pointer-priority-`);
    const runsRoot = resolve(repoRoot, ".ctx/runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(resolve(runsRoot, "latest-run-id"), "run-fresh\n", "utf8");
    await writeFile(resolve(runsRoot, "latest"), "run-stale\n", "utf8");

    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBe("run-fresh");
  });

  test("reads latest run id from legacy plain latest pointer file", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-latest-legacy-`);
    const runsRoot = resolve(repoRoot, ".ctx/runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(resolve(runsRoot, "latest"), "run-legacy-pointer\n", "utf8");

    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBe("run-legacy-pointer");
  });

  test("rejects unsafe run IDs to prevent path traversal writes", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-unsafe-id-`);

    await expect(
      persistRunArtifacts({
        repoRoot,
        runsDir: ".ctx/runs",
        storeRuns: true,
        runRecord: sampleRunRecord("../escape"),
        promptText: "# Prompt\n",
      }),
    ).rejects.toThrow("Invalid run ID");
  });

  test("ignores unsafe latest pointer values", async () => {
    const repoRoot = await mkdtemp(`${tmpdir()}/ctx-run-store-unsafe-pointer-`);
    const runsRoot = resolve(repoRoot, ".ctx/runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(resolve(runsRoot, "latest-run-id"), "../escape\n", "utf8");

    expect(await readLatestRunId(repoRoot, ".ctx/runs")).toBeNull();
  });
});
