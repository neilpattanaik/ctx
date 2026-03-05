import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildManifestReport,
  formatManifestReport,
  loadRunRecordForManifest,
} from "../../src/artifacts";

describe("artifacts manifest helpers", () => {
  test("loads run record by explicit run ID and by last symlink target", () => {
    const repoRoot = "/repo";
    const runsDir = ".ctx/runs";
    const runId = "run-123";
    const runRecordPath = resolve(repoRoot, runsDir, runId, "run.json");
    const files: Record<string, string> = {
      [runRecordPath]: JSON.stringify({
        runId,
        task: "Inspect manifest output",
        config: {
          defaults: { mode: "plan", format: "markdown", budgetTokens: 1200 },
          discovery: { discover: "offline", maxTurns: 4 },
          git: { diff: "off" },
          privacy: { mode: "normal" },
          repo: { root: "/repo" },
        },
        selection: [],
        tokenReport: {
          budget: 1200,
          estimated: 800,
          bySection: { files: 700, metadata: 100 },
          byFile: {},
          degradations: [],
        },
        timing: { phaseDurationsMs: { discovery: 33 } },
      }),
    };
    const links: Record<string, string> = {
      [resolve(repoRoot, runsDir, "latest")]: runId,
    };

    const direct = loadRunRecordForManifest({
      repoRoot,
      runsDir,
      target: runId,
      io: {
        readFile: (path) => files[path] ?? "",
        readLink: (path) => links[path] ?? "",
      },
    });
    expect(direct.runId).toBe(runId);

    const last = loadRunRecordForManifest({
      repoRoot,
      runsDir,
      target: "last",
      io: {
        readFile: (path) => files[path] ?? "",
        readLink: (path) => links[path] ?? "",
      },
    });
    expect(last.runId).toBe(runId);
  });

  test("builds deterministic manifest report from run record data", () => {
    const loaded = {
      runId: "run-xyz",
      runRecordPath: "/repo/.ctx/runs/run-xyz/run.json",
      record: {
        runId: "run-xyz",
        task: "Review auth flow",
        config: {
          defaults: {
            mode: "review",
            format: "markdown+xmltags",
            budgetTokens: 2000,
          },
          discovery: {
            discover: "offline",
            model: "none",
            maxTurns: 3,
          },
          git: {
            diff: "uncommitted",
          },
          privacy: {
            mode: "strict",
          },
          repo: {
            root: "/repo",
          },
        },
        selection: [
          {
            path: "src/z.ts",
            mode: "codemap_only",
            priority: "ref",
            rationale: "reference",
            priorityScore: 20,
          },
          {
            path: "src/a.ts",
            mode: "slices",
            priority: "core",
            rationale: "task term match",
            priorityScore: 200,
            slices: [
              {
                startLine: 8,
                endLine: 24,
                description: "auth flow",
                rationale: "match",
              },
            ],
          },
        ],
        tokenReport: {
          budget: 2000,
          estimated: 1300,
          bySection: {
            files: 1000,
            metadata: 100,
            tree: 200,
          },
          byFile: {
            "src/a.ts": 700,
            "src/z.ts": 300,
          },
          degradations: [
            {
              step: "drop_codemap_only",
              reason: "drop src/z.ts codemap_only",
              delta: 120,
            },
          ],
        },
        dropped: [{ path: "src/legacy.ts", reason: "low priority" }],
        timing: {
          phaseDurationsMs: {
            discovery: 88,
          },
        },
        changedFilesCount: 2,
        patchTokens: 140,
      },
    };

    const report = buildManifestReport(loaded, "/repo");
    expect(report.runId).toBe("run-xyz");
    expect(report.config.mode).toBe("review");
    expect(report.config.discover).toBe("offline");
    expect(report.selection.map((entry) => entry.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(report.selection[0]?.tokenEstimate).toBe(700);
    expect(report.dropped.map((entry) => entry.path)).toEqual([
      "src/legacy.ts",
      "src/z.ts",
    ]);
    expect(report.degradations[0]).toEqual({
      step: "drop_codemap_only",
      action: "drop_codemap_only",
      path: "src/z.ts",
      fromMode: "codemap_only",
      tokensSaved: 120,
    });
    expect(report.git.changed_files_count).toBe(2);
    expect(report.git.patch_tokens).toBe(140);

    const rendered = formatManifestReport(report);
    expect(() => JSON.parse(rendered)).not.toThrow();
    expect(rendered).toContain('"runId": "run-xyz"');
  });
});
