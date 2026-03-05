import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createRuntimeCapture, withCwd } from "./e2e-harness";

const DEFAULT_RUNS = 8;
const DEFAULT_FILE_COUNT = 300;
const DEFAULT_TASK =
  "Investigate service boundaries, config knobs, and likely entrypoints for auth.";

interface SoakCliOptions {
  runs: number;
  fileCount: number;
  task: string;
  json: boolean;
  assertSuccess: boolean;
  assertDeterministic: boolean;
}

interface SoakRunSummary {
  run: number;
  exitCode: number;
  durationMs: number;
  stdoutHash: string;
  stderrHash: string;
  stdoutLines: number;
  stderrLines: number;
  diagnosticsEmitted: number;
}

interface SoakReport {
  generatedAt: string;
  fixtureRepo: string;
  runsRequested: number;
  fileCount: number;
  task: string;
  runs: SoakRunSummary[];
  aggregate: {
    successCount: number;
    failureCount: number;
    exitCodeCounts: Record<string, number>;
    durationMs: {
      min: number;
      max: number;
      avg: number;
      p95: number;
    };
    diagnostics: {
      total: number;
      avgPerRun: number;
    };
  };
  drift: {
    stdoutFingerprintCount: number;
    stderrFingerprintCount: number;
    driftDetected: boolean;
  };
}

function toFixedNumber(value: number): number {
  return Number(value.toFixed(2));
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

function renderHelp(): string {
  return [
    "ctx e2e soak runner",
    "",
    "Usage:",
    "  bun run test/integration/soak-e2e.ts [options]",
    "",
    "Options:",
    `  --runs <n>                 Number of repeated runs (default: ${DEFAULT_RUNS})`,
    `  --file-count <n>           Fixture source files to generate (default: ${DEFAULT_FILE_COUNT})`,
    "  --task <text>              Task text passed to ctx main command",
    "  --json                     Emit JSON report",
    "  --assert-success           Exit 1 if any run exits non-zero",
    "  --assert-deterministic     Exit 1 if stdout/stderr fingerprints drift",
    "  --help                     Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): SoakCliOptions {
  const options: SoakCliOptions = {
    runs: DEFAULT_RUNS,
    fileCount: DEFAULT_FILE_COUNT,
    task: DEFAULT_TASK,
    json: false,
    assertSuccess: false,
    assertDeterministic: false,
  };

  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      throw new Error("HELP");
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--assert-success") {
      options.assertSuccess = true;
      continue;
    }
    if (token === "--assert-deterministic") {
      options.assertDeterministic = true;
      continue;
    }
    if (token === "--runs") {
      options.runs = parsePositiveInteger(readValue(index, "--runs"), "--runs");
      index += 1;
      continue;
    }
    if (token.startsWith("--runs=")) {
      options.runs = parsePositiveInteger(token.slice("--runs=".length), "--runs");
      continue;
    }
    if (token === "--file-count") {
      options.fileCount = parsePositiveInteger(
        readValue(index, "--file-count"),
        "--file-count",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--file-count=")) {
      options.fileCount = parsePositiveInteger(
        token.slice("--file-count=".length),
        "--file-count",
      );
      continue;
    }
    if (token === "--task") {
      options.task = readValue(index, "--task");
      index += 1;
      continue;
    }
    if (token.startsWith("--task=")) {
      options.task = token.slice("--task=".length);
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

function buildFixtureRepo(fileCount: number): string {
  const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-soak-`);
  mkdirSync(resolve(repoRoot, "src"), { recursive: true });

  const packageJsonPath = resolve(repoRoot, "package.json");
  writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: "ctx-e2e-soak-fixture", version: "1.0.0" }, null, 2),
    "utf8",
  );

  for (let index = 0; index < fileCount; index += 1) {
    const group = Math.floor(index / 50);
    const filePath = resolve(
      repoRoot,
      "src",
      `group_${group}`,
      `module_${String(index).padStart(4, "0")}.ts`,
    );
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(
      filePath,
      [
        `export const module_${index} = ${index};`,
        `export function describe_${index}(): string {`,
        `  return "module_${index}";`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  writeFileSync(
    resolve(repoRoot, "README.md"),
    "# soak fixture\n\nThis repository is generated for ctx e2e soak runs.\n",
    "utf8",
  );

  return repoRoot;
}

function normalizeOutput(value: string): string {
  return value
    .replace(/run_id:\s+[^\n]+/g, "run_id: <run-id>")
    .replace(/"run_id":"[^"]+"/g, '"run_id":"<run-id>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<duration_ms>');
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function aggregateReport(
  fixtureRepo: string,
  options: SoakCliOptions,
  runs: SoakRunSummary[],
): SoakReport {
  const successCount = runs.filter((run) => run.exitCode === 0).length;
  const failureCount = runs.length - successCount;
  const exitCodeCounts: Record<string, number> = {};
  for (const run of runs) {
    const key = String(run.exitCode);
    exitCodeCounts[key] = (exitCodeCounts[key] ?? 0) + 1;
  }

  const durations = runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const diagnosticsTotal = runs.reduce(
    (total, run) => total + run.diagnosticsEmitted,
    0,
  );
  const stdoutFingerprintCount = new Set(runs.map((run) => run.stdoutHash)).size;
  const stderrFingerprintCount = new Set(runs.map((run) => run.stderrHash)).size;

  return {
    generatedAt: new Date().toISOString(),
    fixtureRepo,
    runsRequested: options.runs,
    fileCount: options.fileCount,
    task: options.task,
    runs,
    aggregate: {
      successCount,
      failureCount,
      exitCodeCounts,
      durationMs: {
        min: toFixedNumber(durations[0] ?? 0),
        max: toFixedNumber(durations[durations.length - 1] ?? 0),
        avg: toFixedNumber(
          durations.length === 0
            ? 0
            : durations.reduce((sum, value) => sum + value, 0) / durations.length,
        ),
        p95: toFixedNumber(percentile(durations, 0.95)),
      },
      diagnostics: {
        total: diagnosticsTotal,
        avgPerRun: toFixedNumber(
          runs.length === 0 ? 0 : diagnosticsTotal / runs.length,
        ),
      },
    },
    drift: {
      stdoutFingerprintCount,
      stderrFingerprintCount,
      driftDetected: stdoutFingerprintCount > 1 || stderrFingerprintCount > 1,
    },
  };
}

function renderTextReport(report: SoakReport): string {
  const lines: string[] = [];
  lines.push("ctx e2e soak report");
  lines.push(`runs: ${report.runsRequested}`);
  lines.push(`fixture_repo: ${report.fixtureRepo}`);
  lines.push(`task: ${report.task}`);
  lines.push(
    `exit_codes: ${Object.entries(report.aggregate.exitCodeCounts)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ")}`,
  );
  lines.push(
    `duration_ms: min=${report.aggregate.durationMs.min} avg=${report.aggregate.durationMs.avg} p95=${report.aggregate.durationMs.p95} max=${report.aggregate.durationMs.max}`,
  );
  lines.push(
    `diagnostics: total=${report.aggregate.diagnostics.total} avg_per_run=${report.aggregate.diagnostics.avgPerRun}`,
  );
  lines.push(
    `fingerprints: stdout=${report.drift.stdoutFingerprintCount} stderr=${report.drift.stderrFingerprintCount} drift_detected=${report.drift.driftDetected}`,
  );
  return lines.join("\n");
}

export async function runSoakCli(argv: string[]): Promise<number> {
  let options: SoakCliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      console.log(renderHelp());
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Use --help for options.");
    return 2;
  }

  const fixtureRepo = buildFixtureRepo(options.fileCount);
  const capture = createRuntimeCapture({ verbosity: "local" });
  const runSummaries: SoakRunSummary[] = [];

  withCwd(fixtureRepo, () => {
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      const stderrStart = capture.stderr.length;
      const stdoutStart = capture.stdout.length;
      const exitCode = capture.runCommand({
        testCaseId: "soak",
        step: `run-${String(runIndex + 1).padStart(3, "0")}`,
        argv: ["--no-llm", "--json-summary", options.task],
      });

      const assertion = capture.assertionEvents[capture.assertionEvents.length - 1];
      const artifact = capture.commandArtifacts[capture.commandArtifacts.length - 1];
      const stdoutSlice = capture.stdout.slice(stdoutStart).join("\n");
      const stderrSlice = capture.stderr.slice(stderrStart).join("\n");

      const transcript = artifact
        ? (JSON.parse(readFileSync(artifact.transcript_path, "utf8")) as {
            diagnostics_emitted: number;
          })
        : { diagnostics_emitted: 0 };

      runSummaries.push({
        run: runIndex + 1,
        exitCode,
        durationMs: assertion?.duration_ms ?? 0,
        stdoutHash: hashText(normalizeOutput(stdoutSlice)),
        stderrHash: hashText(normalizeOutput(stderrSlice)),
        stdoutLines: assertion?.stdout_line_count ?? 0,
        stderrLines: assertion?.stderr_line_count ?? 0,
        diagnosticsEmitted: transcript.diagnostics_emitted,
      });
    }
  });

  const report = aggregateReport(fixtureRepo, options, runSummaries);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderTextReport(report));
  }

  if (options.assertSuccess && report.aggregate.failureCount > 0) {
    return 1;
  }
  if (options.assertDeterministic && report.drift.driftDetected) {
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const exitCode = await runSoakCli(process.argv.slice(2));
  process.exit(exitCode);
}
