import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  formatExplainReport,
  loadRunRecordForExplain,
  type ExplainIo,
  type ExplainRunRecord,
  type LoadedExplainRun,
} from "../../src/artifacts";

function createIo(files: Record<string, string>, links: Record<string, string>): ExplainIo {
  return {
    readFile: (path) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return files[path]!;
    },
    readLink: (path) => {
      if (!(path in links)) {
        throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
      }
      return links[path]!;
    },
  };
}

function createLoadedRun(record: ExplainRunRecord): LoadedExplainRun {
  return {
    runId: record.runId,
    runRecordPath: `/tmp/${record.runId}/run.json`,
    record,
  };
}

describe("artifacts explain report", () => {
  test("loads run.json for explicit run target", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const runId = "run-abc";
    const runRecordPath = resolve(repoRoot, runsDir, runId, "run.json");
    const io = createIo(
      {
        [runRecordPath]: JSON.stringify({
          runId,
          task: "Investigate auth issue",
          config: {},
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 900,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: {} },
        }),
      },
      {},
    );

    const loaded = loadRunRecordForExplain({
      repoRoot,
      runsDir,
      target: runId,
      io,
    });

    expect(loaded.runId).toBe(runId);
    expect(loaded.runRecordPath).toBe(runRecordPath);
    expect(loaded.record.task).toBe("Investigate auth issue");
  });

  test("resolves latest pointer and renders detailed sections", () => {
    const runId = "run-123";
    const report = formatExplainReport(
      createLoadedRun({
        runId,
        task: "Review auth flow",
        config: {
          discovery: {
            discover: "offline",
            maxTurns: 6,
          },
        },
        selection: [
          {
            path: "src/auth/service.ts",
            mode: "slices",
            priority: "core",
            rationale: "high task-term hit density",
            priorityScore: 950,
            priorityBreakdown: {
              explicit_include: 1000,
              hit_density: 120,
              import_proximity: 90,
            },
          },
        ],
        tokenReport: {
          budget: 4000,
          estimated: 3900,
          initialEstimate: 5200,
          finalEstimate: 3900,
          bySection: {
            files: 3300,
            metadata: 600,
          },
          byFile: {
            "src/auth/service.ts": 2800,
            "src/auth/routes.ts": 700,
            "src/db/client.ts": 400,
          },
          degradations: [
            {
              step: "full_to_slices",
              reason: "degrade src/auth/service.ts full->slices",
              delta: 650,
            },
            {
              action: "drop_codemap_only",
              targetPath: "src/legacy.ts",
              fromMode: "codemap_only",
              tokensSaved: 120,
              reason: "drop src/legacy.ts codemap_only",
            },
          ],
        },
        timing: {
          phaseDurationsMs: {
            discovery: 88,
          },
        },
        dropped: [{ path: "src/binary.bin", reason: "binary exclusion" }],
      }),
    );

    expect(report).toContain("# ctx explain: run-123");
    expect(report).toContain("## DISCOVERY");
    expect(report).toContain("- backend: offline");
    expect(report).toContain("## SELECTION");
    expect(report).toContain("priority_score: 950");
    expect(report).toContain("priority_breakdown:");
    expect(report).toContain(
      "degradation: full_to_slices (full->slices, delta=650)",
    );
    expect(report).toContain("## DROPPED");
    expect(report).toContain("- src/binary.bin: binary exclusion");
    expect(report).toContain("- src/legacy.ts: budget degradation");
    expect(report).toContain("## TOKEN BUDGET");
    expect(report).toContain("- by_file_top_10:");
    expect(report).toContain("## DEGRADATIONS");
    expect(report).toContain(
      "1. full_to_slices [path=src/auth/service.ts, from=full, to=slices]",
    );
    expect(report).toContain(
      "2. drop_codemap_only [path=src/legacy.ts, from=codemap_only]",
    );
  });

  test("loads last run through symlink target", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const runId = "run-last";
    const latestPath = resolve(repoRoot, runsDir, "latest");
    const runRecordPath = resolve(repoRoot, runsDir, runId, "run.json");
    const io = createIo(
      {
        [runRecordPath]: JSON.stringify({
          runId,
          task: "Last run task",
          config: {},
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 500,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: {} },
        }),
      },
      {
        [latestPath]: runId,
      },
    );

    const loaded = loadRunRecordForExplain({
      repoRoot,
      runsDir,
      target: "last",
      io,
    });

    expect(loaded.runId).toBe(runId);
    expect(loaded.record.task).toBe("Last run task");
  });

  test("loads last run when latest pointer is a plain file", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const runId = "run-file-pointer";
    const latestPath = resolve(repoRoot, runsDir, "latest");
    const runRecordPath = resolve(repoRoot, runsDir, runId, "run.json");
    const io = createIo(
      {
        [latestPath]: `${runId}\n`,
        [runRecordPath]: JSON.stringify({
          runId,
          task: "Latest from plain file pointer",
          config: {},
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 500,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: {} },
        }),
      },
      {},
    );

    const loaded = loadRunRecordForExplain({
      repoRoot,
      runsDir,
      target: "last",
      io,
    });

    expect(loaded.runId).toBe(runId);
    expect(loaded.record.task).toBe("Latest from plain file pointer");
  });

  test("loads last run from latest-run-id fallback file when latest pointer is unavailable", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const runId = "run-fallback-pointer";
    const latestFallbackPath = resolve(repoRoot, runsDir, "latest-run-id");
    const runRecordPath = resolve(repoRoot, runsDir, runId, "run.json");
    const io = createIo(
      {
        [latestFallbackPath]: `${runId}\n`,
        [runRecordPath]: JSON.stringify({
          runId,
          task: "Latest from latest-run-id fallback",
          config: {},
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 500,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: {} },
        }),
      },
      {},
    );

    const loaded = loadRunRecordForExplain({
      repoRoot,
      runsDir,
      target: "last",
      io,
    });

    expect(loaded.runId).toBe(runId);
    expect(loaded.record.task).toBe("Latest from latest-run-id fallback");
  });

  test("prefers latest-run-id fallback over stale latest symlink target", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const staleRunId = "run-stale";
    const freshRunId = "run-fresh";
    const latestPath = resolve(repoRoot, runsDir, "latest");
    const latestFallbackPath = resolve(repoRoot, runsDir, "latest-run-id");
    const runRecordPath = resolve(repoRoot, runsDir, freshRunId, "run.json");
    const io = createIo(
      {
        [latestFallbackPath]: `${freshRunId}\n`,
        [runRecordPath]: JSON.stringify({
          runId: freshRunId,
          task: "Fresh run from latest-run-id fallback",
          config: {},
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 500,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: {} },
        }),
      },
      {
        [latestPath]: staleRunId,
      },
    );

    const loaded = loadRunRecordForExplain({
      repoRoot,
      runsDir,
      target: "last",
      io,
    });

    expect(loaded.runId).toBe(freshRunId);
    expect(loaded.record.task).toBe("Fresh run from latest-run-id fallback");
  });

  test("rejects invalid run target paths to prevent traversal", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const io = createIo({}, {});

    expect(() =>
      loadRunRecordForExplain({
        repoRoot,
        runsDir,
        target: "../outside",
        io,
      }),
    ).toThrow("run target is invalid");
  });
});
