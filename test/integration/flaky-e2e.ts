import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_COMMAND = ["bun", "test", "test/integration/cli-e2e.test.ts"];
const DEFAULT_CYCLES = 3;
const DEFAULT_MAX_RERUNS = 1;
const DEFAULT_RECURRING_THRESHOLD = 2;
const DEFAULT_BEAD_PARENT = "ctx-1az.3.4";
const DEFAULT_HISTORY_PATH = "test-results/e2e-flake-history.json";

export interface FlakeRunnerOptions {
  command: string[];
  cycles: number;
  maxReruns: number;
  json: boolean;
  failOnFlaky: boolean;
  recurringThreshold: number;
  historyPath: string;
  reportPath?: string;
  autoCreateBeads: boolean;
  beadParent: string;
}

export interface FlakeAttemptResult {
  attempt: number;
  exitCode: number;
  durationMs: number;
  failedTests: string[];
  failureSignature: string;
  stdoutHash: string;
  stderrHash: string;
  stdoutPreview: string;
  stderrPreview: string;
}

export interface FlakeCycleResult {
  cycle: number;
  classification: "pass" | "flaky" | "persistent_fail" | "unstable_fail";
  attempts: FlakeAttemptResult[];
  flakySignature?: string;
}

interface DurationSummary {
  min: number;
  avg: number;
  max: number;
  p95: number;
}

export interface FlakeHistory {
  updatedAt: string;
  flakySignatureCounts: Record<string, number>;
}

export interface FlakeBeadAction {
  signature: string;
  count: number;
  created: boolean;
  issueId?: string;
  error?: string;
}

export interface FlakeReport {
  generatedAt: string;
  command: string[];
  cycles: number;
  maxReruns: number;
  failOnFlaky: boolean;
  recurringThreshold: number;
  summary: {
    passCycles: number;
    flakyCycles: number;
    persistentFailCycles: number;
    unstableFailCycles: number;
    totalAttempts: number;
    durationMs: DurationSummary;
    stdoutFingerprintCount: number;
    stderrFingerprintCount: number;
  };
  flakySignatures: Record<string, number>;
  recurringFlakeSignatures: string[];
  newlyRecurringFlakeSignatures: string[];
  history: FlakeHistory;
  beadActions: FlakeBeadAction[];
  cyclesData: FlakeCycleResult[];
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

function readNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer, received: ${value}`);
  }
  return parsed;
}

function trimPreview(value: string, limit = 4_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function normalizeForHash(value: string): string {
  return value
    .replace(/\[\d+(?:\.\d+)?ms\]/g, "[<ms>]")
    .replace(/duration_ms\":\d+/g, 'duration_ms":<duration_ms>')
    .replace(/run_id:\s+[^\n]+/g, "run_id: <run-id>")
    .replace(/"run_id":"[^"]+"/g, '"run_id":"<run-id>"')
    .replace(/\b\d{8}T\d{6}-[0-9a-f]{8}\b/g, "<run-id>");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function parseFailedTestNames(output: string): string[] {
  const failed = new Set<string>();
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\(fail\)\s+(.+?)(?:\s+\[\d.*)?$/.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    failed.add(match[1].trim());
  }
  return [...failed].sort((left, right) => left.localeCompare(right));
}

export function buildFailureSignature(failedTests: readonly string[], exitCode: number): string {
  if (exitCode === 0) {
    return "PASS";
  }
  if (failedTests.length === 0) {
    return "__unknown_failure_signature__";
  }
  return [...failedTests].join(" | ");
}

export function classifyCycleAttempts(
  attempts: ReadonlyArray<{ exitCode: number; failureSignature: string }>,
): FlakeCycleResult["classification"] {
  if (attempts.length === 0) {
    return "unstable_fail";
  }
  if ((attempts[0]?.exitCode ?? 1) === 0) {
    return "pass";
  }
  if (attempts.slice(1).some((attempt) => attempt.exitCode === 0)) {
    return "flaky";
  }
  const signatures = new Set(
    attempts
      .filter((attempt) => attempt.exitCode !== 0)
      .map((attempt) => attempt.failureSignature),
  );
  return signatures.size <= 1 ? "persistent_fail" : "unstable_fail";
}

export function mergeFlakyHistory(
  history: FlakeHistory,
  flakySignatures: Readonly<Record<string, number>>,
): FlakeHistory {
  const nextCounts: Record<string, number> = {
    ...history.flakySignatureCounts,
  };
  for (const [signature, count] of Object.entries(flakySignatures)) {
    nextCounts[signature] = (nextCounts[signature] ?? 0) + count;
  }
  return {
    updatedAt: new Date().toISOString(),
    flakySignatureCounts: Object.fromEntries(
      Object.entries(nextCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function findRecurringFlakeSignatures(
  counts: Readonly<Record<string, number>>,
  threshold: number,
): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count >= threshold)
    .map(([signature]) => signature)
    .sort((left, right) => left.localeCompare(right));
}

export function findNewlyRecurringFlakeSignatures(
  previousCounts: Readonly<Record<string, number>>,
  currentCounts: Readonly<Record<string, number>>,
  threshold: number,
): string[] {
  return Object.entries(currentCounts)
    .filter(([signature, current]) => {
      const previous = previousCounts[signature] ?? 0;
      return previous < threshold && current >= threshold;
    })
    .map(([signature]) => signature)
    .sort((left, right) => left.localeCompare(right));
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function summarizeDurations(values: readonly number[]): DurationSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const avg = sorted.length === 0 ? 0 : total / sorted.length;
  return {
    min: Number((sorted[0] ?? 0).toFixed(2)),
    avg: Number(avg.toFixed(2)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
  };
}

function runAttempt(
  command: readonly string[],
  attempt: number,
): FlakeAttemptResult {
  const startedAt = Date.now();
  const result = spawnSync(command[0] ?? "bun", command.slice(1), {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const failedTests = parseFailedTestNames(`${stdout}\n${stderr}`);
  const failureSignature = buildFailureSignature(failedTests, exitCode);
  return {
    attempt,
    exitCode,
    durationMs,
    failedTests,
    failureSignature,
    stdoutHash: hashText(normalizeForHash(stdout)),
    stderrHash: hashText(normalizeForHash(stderr)),
    stdoutPreview: trimPreview(stdout),
    stderrPreview: trimPreview(stderr),
  };
}

function loadHistory(pathValue: string): FlakeHistory {
  const resolved = resolve(pathValue);
  try {
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw) as FlakeHistory;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid history payload");
    }
    const counts = parsed.flakySignatureCounts;
    if (!counts || typeof counts !== "object") {
      throw new Error("Invalid history counts payload");
    }
    const normalizedCounts: Record<string, number> = {};
    for (const [signature, count] of Object.entries(counts)) {
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        continue;
      }
      normalizedCounts[signature] = Math.floor(count);
    }
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      flakySignatureCounts: normalizedCounts,
    };
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      flakySignatureCounts: {},
    };
  }
}

function writeJson(pathValue: string, payload: unknown): void {
  const absolutePath = resolve(pathValue);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, JSON.stringify(payload, null, 2), "utf8");
}

function shortenSignature(signature: string): string {
  if (signature.length <= 72) {
    return signature;
  }
  return `${signature.slice(0, 72)}...`;
}

function maybeCreateRecurringFlakeBeads(
  options: FlakeRunnerOptions,
  recurringSignatures: readonly string[],
  history: FlakeHistory,
): FlakeBeadAction[] {
  const actions: FlakeBeadAction[] = [];
  if (!options.autoCreateBeads) {
    return actions;
  }

  for (const signature of recurringSignatures) {
    const count = history.flakySignatureCounts[signature] ?? 0;
    const title = `Recurring flaky e2e: ${shortenSignature(signature)}`;
    const description = [
      "Auto-created by flaky e2e policy runner.",
      `Signature: ${signature}`,
      `Observed flaky count: ${count}`,
      `Parent bead: ${options.beadParent}`,
    ].join("\n");
    const result = spawnSync(
      "br",
      [
        "create",
        title,
        "-t",
        "bug",
        "-p",
        "2",
        "--deps",
        `discovered-from:${options.beadParent}`,
        "-d",
        description,
        "--json",
      ],
      {
        encoding: "utf8",
        env: { ...process.env },
      },
    );

    if ((result.status ?? 1) !== 0) {
      actions.push({
        signature,
        count,
        created: false,
        error: (result.stderr ?? result.stdout ?? "Failed to create bead").trim(),
      });
      continue;
    }

    let issueId: string | undefined;
    try {
      const parsed = JSON.parse(result.stdout ?? "{}") as { id?: string };
      if (typeof parsed.id === "string" && parsed.id.length > 0) {
        issueId = parsed.id;
      }
    } catch {
      // Keep undefined issue id if parsing fails.
    }
    actions.push({
      signature,
      count,
      created: true,
      issueId,
    });
  }
  return actions;
}

function renderTextReport(report: FlakeReport): string {
  const lines: string[] = [];
  lines.push("ctx e2e flake policy report");
  lines.push(`command: ${report.command.join(" ")}`);
  lines.push(`cycles: ${report.cycles}`);
  lines.push(`max_reruns: ${report.maxReruns}`);
  lines.push(`pass_cycles: ${report.summary.passCycles}`);
  lines.push(`flaky_cycles: ${report.summary.flakyCycles}`);
  lines.push(`persistent_fail_cycles: ${report.summary.persistentFailCycles}`);
  lines.push(`unstable_fail_cycles: ${report.summary.unstableFailCycles}`);
  lines.push(
    `attempt_duration_ms: min=${report.summary.durationMs.min} avg=${report.summary.durationMs.avg} p95=${report.summary.durationMs.p95} max=${report.summary.durationMs.max}`,
  );
  lines.push(
    `output_fingerprints: stdout=${report.summary.stdoutFingerprintCount} stderr=${report.summary.stderrFingerprintCount}`,
  );
  const recurring = report.recurringFlakeSignatures;
  lines.push(
    recurring.length === 0
      ? "recurring_flakes: none"
      : `recurring_flakes: ${recurring.join(" | ")}`,
  );
  const newRecurring = report.newlyRecurringFlakeSignatures;
  lines.push(
    newRecurring.length === 0
      ? "new_recurring_flakes: none"
      : `new_recurring_flakes: ${newRecurring.join(" | ")}`,
  );
  return lines.join("\n");
}

function renderHelp(): string {
  return [
    "ctx e2e flaky-policy runner",
    "",
    "Usage:",
    "  bun run test/integration/flaky-e2e.ts [options]",
    "",
    "Options:",
    `  --cycles <n>               Independent cycles (default: ${DEFAULT_CYCLES})`,
    `  --max-reruns <n>           Controlled reruns per failed cycle (default: ${DEFAULT_MAX_RERUNS})`,
    "  --json                     Emit JSON report to stdout",
    "  --fail-on-flaky            Exit 1 when flaky cycles are detected",
    `  --recurring-threshold <n>  Signature count threshold for recurring flakes (default: ${DEFAULT_RECURRING_THRESHOLD})`,
    `  --history <path>           History file path (default: ${DEFAULT_HISTORY_PATH})`,
    "  --report <path>            Write full JSON report to file",
    "  --auto-create-beads        Auto-create follow-up beads for recurring flakes",
    `  --bead-parent <id>         Parent bead for discovered-from links (default: ${DEFAULT_BEAD_PARENT})`,
    "  --command <cmd...>         Override test command (requires one or more tokens)",
    "  --help                     Show this help text",
  ].join("\n");
}

export function parseFlakyRunnerArgs(argv: string[]): FlakeRunnerOptions {
  const options: FlakeRunnerOptions = {
    command: [...DEFAULT_COMMAND],
    cycles: DEFAULT_CYCLES,
    maxReruns: DEFAULT_MAX_RERUNS,
    json: false,
    failOnFlaky: false,
    recurringThreshold: DEFAULT_RECURRING_THRESHOLD,
    historyPath: DEFAULT_HISTORY_PATH,
    autoCreateBeads: false,
    beadParent: DEFAULT_BEAD_PARENT,
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
    if (token === "--fail-on-flaky") {
      options.failOnFlaky = true;
      continue;
    }
    if (token === "--auto-create-beads") {
      options.autoCreateBeads = true;
      continue;
    }
    if (token === "--cycles") {
      options.cycles = readPositiveInteger(readValue(index, "--cycles"), "--cycles");
      index += 1;
      continue;
    }
    if (token.startsWith("--cycles=")) {
      options.cycles = readPositiveInteger(token.slice("--cycles=".length), "--cycles");
      continue;
    }
    if (token === "--max-reruns") {
      options.maxReruns = readNonNegativeInteger(
        readValue(index, "--max-reruns"),
        "--max-reruns",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--max-reruns=")) {
      options.maxReruns = readNonNegativeInteger(
        token.slice("--max-reruns=".length),
        "--max-reruns",
      );
      continue;
    }
    if (token === "--recurring-threshold") {
      options.recurringThreshold = readPositiveInteger(
        readValue(index, "--recurring-threshold"),
        "--recurring-threshold",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--recurring-threshold=")) {
      options.recurringThreshold = readPositiveInteger(
        token.slice("--recurring-threshold=".length),
        "--recurring-threshold",
      );
      continue;
    }
    if (token === "--history") {
      options.historyPath = readValue(index, "--history");
      index += 1;
      continue;
    }
    if (token.startsWith("--history=")) {
      options.historyPath = token.slice("--history=".length);
      continue;
    }
    if (token === "--report") {
      options.reportPath = readValue(index, "--report");
      index += 1;
      continue;
    }
    if (token.startsWith("--report=")) {
      options.reportPath = token.slice("--report=".length);
      continue;
    }
    if (token === "--bead-parent") {
      options.beadParent = readValue(index, "--bead-parent");
      index += 1;
      continue;
    }
    if (token.startsWith("--bead-parent=")) {
      options.beadParent = token.slice("--bead-parent=".length);
      continue;
    }
    if (token === "--command") {
      const command = argv.slice(index + 1).filter((part) => part.trim().length > 0);
      if (command.length === 0) {
        throw new Error("--command requires one or more command tokens");
      }
      options.command = command;
      break;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

export function runFlakyPolicy(options: FlakeRunnerOptions): FlakeReport {
  const cyclesData: FlakeCycleResult[] = [];
  const flakySignatures: Record<string, number> = {};

  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    const attempts: FlakeAttemptResult[] = [];
    const first = runAttempt(options.command, 1);
    attempts.push(first);

    if (first.exitCode !== 0) {
      for (let rerun = 1; rerun <= options.maxReruns; rerun += 1) {
        const rerunAttempt = runAttempt(options.command, rerun + 1);
        attempts.push(rerunAttempt);
        if (rerunAttempt.exitCode === 0) {
          break;
        }
      }
    }

    const classification = classifyCycleAttempts(attempts);
    let flakySignature: string | undefined;
    if (classification === "flaky") {
      flakySignature = first.failureSignature;
      flakySignatures[flakySignature] = (flakySignatures[flakySignature] ?? 0) + 1;
    }

    cyclesData.push({
      cycle,
      classification,
      attempts,
      flakySignature,
    });
  }

  const passCycles = cyclesData.filter((cycle) => cycle.classification === "pass").length;
  const flakyCycles = cyclesData.filter((cycle) => cycle.classification === "flaky").length;
  const persistentFailCycles = cyclesData.filter(
    (cycle) => cycle.classification === "persistent_fail",
  ).length;
  const unstableFailCycles = cyclesData.filter(
    (cycle) => cycle.classification === "unstable_fail",
  ).length;
  const allAttempts = cyclesData.flatMap((cycle) => cycle.attempts);
  const durationMs = summarizeDurations(allAttempts.map((attempt) => attempt.durationMs));
  const stdoutFingerprintCount = new Set(allAttempts.map((attempt) => attempt.stdoutHash)).size;
  const stderrFingerprintCount = new Set(allAttempts.map((attempt) => attempt.stderrHash)).size;

  const previousHistory = loadHistory(options.historyPath);
  const history = mergeFlakyHistory(previousHistory, flakySignatures);
  const recurringFlakeSignatures = findRecurringFlakeSignatures(
    history.flakySignatureCounts,
    options.recurringThreshold,
  );
  const newlyRecurringFlakeSignatures = findNewlyRecurringFlakeSignatures(
    previousHistory.flakySignatureCounts,
    history.flakySignatureCounts,
    options.recurringThreshold,
  );
  const beadActions = maybeCreateRecurringFlakeBeads(
    options,
    newlyRecurringFlakeSignatures,
    history,
  );

  const report: FlakeReport = {
    generatedAt: new Date().toISOString(),
    command: [...options.command],
    cycles: options.cycles,
    maxReruns: options.maxReruns,
    failOnFlaky: options.failOnFlaky,
    recurringThreshold: options.recurringThreshold,
    summary: {
      passCycles,
      flakyCycles,
      persistentFailCycles,
      unstableFailCycles,
      totalAttempts: allAttempts.length,
      durationMs,
      stdoutFingerprintCount,
      stderrFingerprintCount,
    },
    flakySignatures: Object.fromEntries(
      Object.entries(flakySignatures).sort(([left], [right]) => left.localeCompare(right)),
    ),
    recurringFlakeSignatures,
    newlyRecurringFlakeSignatures,
    history,
    beadActions,
    cyclesData,
  };

  writeJson(options.historyPath, history);
  if (options.reportPath) {
    writeJson(options.reportPath, report);
  }
  return report;
}

export async function runFlakyPolicyCli(argv: string[]): Promise<number> {
  let options: FlakeRunnerOptions;
  try {
    options = parseFlakyRunnerArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      console.log(renderHelp());
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Use --help for options.");
    return 2;
  }

  const report = runFlakyPolicy(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderTextReport(report));
  }

  if (report.summary.persistentFailCycles > 0 || report.summary.unstableFailCycles > 0) {
    return 1;
  }
  if (options.failOnFlaky && report.summary.flakyCycles > 0) {
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const exitCode = await runFlakyPolicyCli(process.argv.slice(2));
  process.exit(exitCode);
}
