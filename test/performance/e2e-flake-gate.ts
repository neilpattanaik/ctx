import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FLAKE_REPORT_SCHEMA_VERSION = "ctx-e2e-flake-report.v1";
const FLAKE_HISTORY_SCHEMA_VERSION = "ctx-e2e-flake-history.v1";
const DEFAULT_MAX_RERUNS = 1;
const DEFAULT_REPORT_PATH = "test-results/e2e-flake-report.json";
const DEFAULT_HISTORY_PATH = "test-results/e2e-flake-history.json";
const DEFAULT_FLAKE_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_PARENT_BEAD = "ctx-1az.3.4";
const DEFAULT_BEAD_PRIORITY = 1;

export type FlakeClassification = "stable_pass" | "flaky_recovered" | "hard_fail";

export interface AttemptSnapshot {
  attempt: number;
  exit_code: number;
  signal: string | null;
  duration_ms: number;
  stdout_line_count: number;
  stderr_line_count: number;
  stdout_hash: string;
  stderr_hash: string;
  combined_hash: string;
}

export interface FlakeHistoryEntry {
  timestamp: string;
  classification: FlakeClassification;
  command_hash: string;
  combined_hash: string;
  attempts: number;
}

interface FlakeHistoryStore {
  schema_version: typeof FLAKE_HISTORY_SCHEMA_VERSION;
  entries: FlakeHistoryEntry[];
}

interface FollowUpBeadResult {
  status: "not_needed" | "skipped" | "created" | "existing" | "error";
  issue_id?: string;
  message?: string;
}

interface FlakeReport {
  schema_version: typeof FLAKE_REPORT_SCHEMA_VERSION;
  generated_at: string;
  command: string;
  command_hash: string;
  policy: {
    max_reruns: number;
    strict_flaky_failure: boolean;
    flake_threshold: number;
    window_days: number;
    auto_open_bead: boolean;
    parent_bead: string;
    bead_priority: number;
  };
  attempts: AttemptSnapshot[];
  classification: FlakeClassification;
  variance: {
    stdout_fingerprint_count: number;
    stderr_fingerprint_count: number;
    combined_fingerprint_count: number;
    variance_detected: boolean;
  };
  recurring_flake: {
    count_within_window: number;
    threshold: number;
    triggered: boolean;
  };
  follow_up_bead: FollowUpBeadResult;
  final_exit_code: number;
}

export interface FlakeGateCliOptions {
  command: string;
  maxReruns: number;
  reportPath: string;
  historyPath: string;
  flakeThreshold: number;
  windowDays: number;
  allowFlakyPass: boolean;
  autoOpenBead: boolean;
  parentBead: string;
  beadPriority: number;
  json: boolean;
}

function renderHelp(): string {
  return [
    "e2e flake gate",
    "",
    "Usage:",
    "  bun run test/performance/e2e-flake-gate.ts --command \"<shell command>\" [options]",
    "",
    "Options:",
    "  --command <cmd>            Command to execute under flake gate (required)",
    `  --max-reruns <n>           Additional retries after first failure (default: ${DEFAULT_MAX_RERUNS})`,
    `  --report <path>            JSON report path (default: ${DEFAULT_REPORT_PATH})`,
    `  --history <path>           Flake history path (default: ${DEFAULT_HISTORY_PATH})`,
    `  --flake-threshold <n>      Recurring flake threshold (default: ${DEFAULT_FLAKE_THRESHOLD})`,
    `  --window-days <n>          Recurring flake lookback window in days (default: ${DEFAULT_WINDOW_DAYS})`,
    "  --allow-flaky-pass         Return 0 when flaky_recovered (default strict failure)",
    "  --auto-open-bead           Attempt auto-open recurring flake bead",
    "  --no-auto-open-bead        Disable automatic bead creation",
    `  --parent-bead <id>         Parent/discovered-from bead id (default: ${DEFAULT_PARENT_BEAD})`,
    `  --bead-priority <0-4>      Priority for auto-opened beads (default: ${DEFAULT_BEAD_PRIORITY})`,
    "  --json                     Print report JSON to stdout",
    "  --help                     Show this help text",
    "",
    "Environment:",
    "  CTX_E2E_FLAKE_AUTO_BEAD=1    Enable auto-open bead behavior by default",
  ].join("\n");
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer, received: ${value}`);
  }
  return parsed;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseFlakeGateArgs(argv: string[]): FlakeGateCliOptions {
  const options: FlakeGateCliOptions = {
    command: "",
    maxReruns: DEFAULT_MAX_RERUNS,
    reportPath: DEFAULT_REPORT_PATH,
    historyPath: DEFAULT_HISTORY_PATH,
    flakeThreshold: DEFAULT_FLAKE_THRESHOLD,
    windowDays: DEFAULT_WINDOW_DAYS,
    allowFlakyPass: false,
    autoOpenBead: process.env.CTX_E2E_FLAKE_AUTO_BEAD === "1",
    parentBead: DEFAULT_PARENT_BEAD,
    beadPriority: DEFAULT_BEAD_PRIORITY,
    json: false,
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
    if (token === "--allow-flaky-pass") {
      options.allowFlakyPass = true;
      continue;
    }
    if (token === "--auto-open-bead") {
      options.autoOpenBead = true;
      continue;
    }
    if (token === "--no-auto-open-bead") {
      options.autoOpenBead = false;
      continue;
    }
    if (token === "--command") {
      options.command = readValue(argv, index, "--command");
      index += 1;
      continue;
    }
    if (token.startsWith("--command=")) {
      options.command = token.slice("--command=".length);
      continue;
    }
    if (token === "--max-reruns") {
      options.maxReruns = parsePositiveInteger(
        readValue(argv, index, "--max-reruns"),
        "--max-reruns",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--max-reruns=")) {
      options.maxReruns = parsePositiveInteger(
        token.slice("--max-reruns=".length),
        "--max-reruns",
      );
      continue;
    }
    if (token === "--report") {
      options.reportPath = readValue(argv, index, "--report");
      index += 1;
      continue;
    }
    if (token.startsWith("--report=")) {
      options.reportPath = token.slice("--report=".length);
      continue;
    }
    if (token === "--history") {
      options.historyPath = readValue(argv, index, "--history");
      index += 1;
      continue;
    }
    if (token.startsWith("--history=")) {
      options.historyPath = token.slice("--history=".length);
      continue;
    }
    if (token === "--flake-threshold") {
      options.flakeThreshold = parsePositiveInteger(
        readValue(argv, index, "--flake-threshold"),
        "--flake-threshold",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--flake-threshold=")) {
      options.flakeThreshold = parsePositiveInteger(
        token.slice("--flake-threshold=".length),
        "--flake-threshold",
      );
      continue;
    }
    if (token === "--window-days") {
      options.windowDays = parsePositiveInteger(
        readValue(argv, index, "--window-days"),
        "--window-days",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--window-days=")) {
      options.windowDays = parsePositiveInteger(
        token.slice("--window-days=".length),
        "--window-days",
      );
      continue;
    }
    if (token === "--parent-bead") {
      options.parentBead = readValue(argv, index, "--parent-bead").trim();
      index += 1;
      continue;
    }
    if (token.startsWith("--parent-bead=")) {
      options.parentBead = token.slice("--parent-bead=".length).trim();
      continue;
    }
    if (token === "--bead-priority") {
      options.beadPriority = parsePositiveInteger(
        readValue(argv, index, "--bead-priority"),
        "--bead-priority",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--bead-priority=")) {
      options.beadPriority = parsePositiveInteger(
        token.slice("--bead-priority=".length),
        "--bead-priority",
      );
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  if (!options.command.trim()) {
    throw new Error("--command is required");
  }
  if (!options.parentBead) {
    throw new Error("--parent-bead must not be empty");
  }
  if (options.beadPriority < 0 || options.beadPriority > 4) {
    throw new Error("--bead-priority must be between 0 and 4");
  }
  if (options.flakeThreshold === 0) {
    throw new Error("--flake-threshold must be greater than 0");
  }
  if (options.windowDays === 0) {
    throw new Error("--window-days must be greater than 0");
  }

  return options;
}

function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split("\n").length;
}

export function normalizeFlakeOutput(value: string): string {
  return value
    .replace(/\brun_id:\s*[a-z0-9-]+\b/gi, "run_id: <run-id>")
    .replace(/"run_id":"[^"]+"/g, '"run_id":"<run-id>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<duration_ms>')
    .replace(/\/tmp\/ctx-[^/\s]+/g, "<tmp-repo>")
    .replace(/\b\d{8}T\d{6}-[0-9a-f]{8}\b/g, "<run-id>");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function classifyAttemptExitCodes(exitCodes: readonly number[]): FlakeClassification {
  if (exitCodes.length === 0) {
    return "hard_fail";
  }
  if (exitCodes[0] === 0) {
    return "stable_pass";
  }
  return exitCodes.some((code) => code === 0) ? "flaky_recovered" : "hard_fail";
}

export function decideGateExitCode(
  classification: FlakeClassification,
  allowFlakyPass: boolean,
  attempts: readonly AttemptSnapshot[],
): number {
  if (classification === "stable_pass") {
    return 0;
  }
  if (classification === "flaky_recovered") {
    return allowFlakyPass ? 0 : 1;
  }
  const last = attempts[attempts.length - 1];
  if (!last || last.exit_code === 0) {
    return 1;
  }
  return last.exit_code;
}

function loadHistory(path: string): FlakeHistoryStore {
  if (!existsSync(path)) {
    return { schema_version: FLAKE_HISTORY_SCHEMA_VERSION, entries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FlakeHistoryStore>;
    if (
      parsed &&
      parsed.schema_version === FLAKE_HISTORY_SCHEMA_VERSION &&
      Array.isArray(parsed.entries)
    ) {
      return {
        schema_version: FLAKE_HISTORY_SCHEMA_VERSION,
        entries: parsed.entries.filter((entry): entry is FlakeHistoryEntry => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const value = entry as Partial<FlakeHistoryEntry>;
          return (
            typeof value.timestamp === "string" &&
            typeof value.classification === "string" &&
            typeof value.command_hash === "string" &&
            typeof value.combined_hash === "string" &&
            typeof value.attempts === "number"
          );
        }),
      };
    }
  } catch {
    // Fall through to reset malformed history.
  }
  return { schema_version: FLAKE_HISTORY_SCHEMA_VERSION, entries: [] };
}

function persistHistory(path: string, history: FlakeHistoryStore): void {
  ensureParentDirectory(path);
  writeFileSync(path, JSON.stringify(history, null, 2), "utf8");
}

function pruneHistoryEntries(entries: readonly FlakeHistoryEntry[], nowMs: number): FlakeHistoryEntry[] {
  const retentionDays = 90;
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const timestampMs = Date.parse(entry.timestamp);
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
  });
}

export function computeRecurringFlakeCount(
  entries: readonly FlakeHistoryEntry[],
  commandHash: string,
  windowDays: number,
  nowMs = Date.now(),
): number {
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (entry.classification !== "flaky_recovered") {
      return false;
    }
    if (entry.command_hash !== commandHash) {
      return false;
    }
    const timestampMs = Date.parse(entry.timestamp);
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
  }).length;
}

function runShellCommand(command: string): {
  execution: SpawnSyncReturns<string>;
  durationMs: number;
} {
  const startedAt = Date.now();
  const execution = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Math.max(0, Date.now() - startedAt);
  return { execution, durationMs };
}

function toAttemptSnapshot(
  attempt: number,
  execution: SpawnSyncReturns<string>,
  durationMs: number,
): AttemptSnapshot {
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";

  if (stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  const normalizedStdout = normalizeFlakeOutput(stdout);
  const normalizedStderr = normalizeFlakeOutput(stderr);
  const combined = `${normalizedStdout}\n---stderr---\n${normalizedStderr}`;

  return {
    attempt,
    exit_code:
      typeof execution.status === "number"
        ? execution.status
        : execution.error
          ? 1
          : 1,
    signal: execution.signal,
    duration_ms: durationMs,
    stdout_line_count: countLines(stdout),
    stderr_line_count: countLines(stderr),
    stdout_hash: hashText(normalizedStdout),
    stderr_hash: hashText(normalizedStderr),
    combined_hash: hashText(combined),
  };
}

function isBrAvailable(): boolean {
  const check = spawnSync("br", ["--version"], {
    encoding: "utf8",
    env: process.env,
  });
  return check.status === 0;
}

function parseIssueId(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { id?: unknown };
      if (first && typeof first.id === "string") {
        return first.id;
      }
    }
    if (parsed && typeof parsed === "object") {
      const value = parsed as { id?: unknown };
      if (typeof value.id === "string") {
        return value.id;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function maybeCreateRecurringFlakeBead(options: {
  recurring: boolean;
  autoOpenBead: boolean;
  commandHash: string;
  parentBead: string;
  beadPriority: number;
}): FollowUpBeadResult {
  if (!options.recurring) {
    return { status: "not_needed" };
  }
  if (!options.autoOpenBead) {
    return { status: "skipped", message: "auto-open disabled" };
  }
  if (!isBrAvailable()) {
    return { status: "skipped", message: "br binary not available" };
  }

  const marker = `[flake:${options.commandHash.slice(0, 8)}]`;
  const listResult = spawnSync("br", ["list", "--status", "open", "--json"], {
    encoding: "utf8",
    env: process.env,
  });
  if (listResult.status !== 0) {
    return {
      status: "error",
      message: `br list failed: ${listResult.stderr?.trim() || "unknown error"}`,
    };
  }

  try {
    const issues = JSON.parse(listResult.stdout || "[]") as Array<{
      id?: string;
      title?: string;
    }>;
    const existing = issues.find(
      (issue) =>
        typeof issue.title === "string" && issue.title.includes(marker) && typeof issue.id === "string",
    );
    if (existing?.id) {
      return { status: "existing", issue_id: existing.id };
    }
  } catch {
    return { status: "error", message: "failed to parse br list output" };
  }

  const title = `Recurring e2e flake detected ${marker}`;
  const createResult = spawnSync(
    "br",
    [
      "create",
      title,
      "-t",
      "bug",
      "-p",
      String(options.beadPriority),
      "--deps",
      `discovered-from:${options.parentBead}`,
      "--json",
    ],
    {
      encoding: "utf8",
      env: process.env,
    },
  );

  if (createResult.status !== 0) {
    return {
      status: "error",
      message: `br create failed: ${createResult.stderr?.trim() || "unknown error"}`,
    };
  }

  const issueId = parseIssueId(createResult.stdout ?? "");
  if (!issueId) {
    return {
      status: "error",
      message: "br create succeeded but issue id could not be parsed",
    };
  }

  return { status: "created", issue_id: issueId };
}

function writeReport(path: string, report: FlakeReport): void {
  ensureParentDirectory(path);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
}

function printAttemptPrefix(attempt: number, totalAttempts: number): void {
  process.stderr.write(`\n[flake-gate] attempt ${attempt}/${totalAttempts}\n`);
}

export async function runE2eFlakeGateCli(argv: string[]): Promise<number> {
  let options: FlakeGateCliOptions;
  try {
    options = parseFlakeGateArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      console.log(renderHelp());
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Use --help for options.");
    return 2;
  }

  const totalAttempts = options.maxReruns + 1;
  const commandHash = hashText(options.command.trim());
  const attempts: AttemptSnapshot[] = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    printAttemptPrefix(attempt, totalAttempts);
    const { execution, durationMs } = runShellCommand(options.command);
    const snapshot = toAttemptSnapshot(attempt, execution, durationMs);
    attempts.push(snapshot);

    const shouldContinue = snapshot.exit_code !== 0 && attempt < totalAttempts;
    if (!shouldContinue) {
      break;
    }
    process.stderr.write(
      `[flake-gate] command failed with exit ${snapshot.exit_code}; rerunning...\n`,
    );
  }

  const classification = classifyAttemptExitCodes(attempts.map((attempt) => attempt.exit_code));
  const stdoutFingerprintCount = new Set(attempts.map((attempt) => attempt.stdout_hash)).size;
  const stderrFingerprintCount = new Set(attempts.map((attempt) => attempt.stderr_hash)).size;
  const combinedFingerprintCount = new Set(attempts.map((attempt) => attempt.combined_hash)).size;

  const now = new Date();
  const nowMs = now.getTime();
  const history = loadHistory(options.historyPath);
  const prunedEntries = pruneHistoryEntries(history.entries, nowMs);
  const latestCombinedHash = attempts[attempts.length - 1]?.combined_hash ?? "";

  if (classification !== "stable_pass") {
    prunedEntries.push({
      timestamp: now.toISOString(),
      classification,
      command_hash: commandHash,
      combined_hash: latestCombinedHash,
      attempts: attempts.length,
    });
  }

  const recurringCount = computeRecurringFlakeCount(
    prunedEntries,
    commandHash,
    options.windowDays,
    nowMs,
  );
  const recurringTriggered = recurringCount >= options.flakeThreshold;

  const followUpBead = maybeCreateRecurringFlakeBead({
    recurring: recurringTriggered,
    autoOpenBead: options.autoOpenBead,
    commandHash,
    parentBead: options.parentBead,
    beadPriority: options.beadPriority,
  });

  const finalExitCode = decideGateExitCode(classification, options.allowFlakyPass, attempts);

  const report: FlakeReport = {
    schema_version: FLAKE_REPORT_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    command: options.command,
    command_hash: commandHash,
    policy: {
      max_reruns: options.maxReruns,
      strict_flaky_failure: !options.allowFlakyPass,
      flake_threshold: options.flakeThreshold,
      window_days: options.windowDays,
      auto_open_bead: options.autoOpenBead,
      parent_bead: options.parentBead,
      bead_priority: options.beadPriority,
    },
    attempts,
    classification,
    variance: {
      stdout_fingerprint_count: stdoutFingerprintCount,
      stderr_fingerprint_count: stderrFingerprintCount,
      combined_fingerprint_count: combinedFingerprintCount,
      variance_detected:
        stdoutFingerprintCount > 1 || stderrFingerprintCount > 1 || combinedFingerprintCount > 1,
    },
    recurring_flake: {
      count_within_window: recurringCount,
      threshold: options.flakeThreshold,
      triggered: recurringTriggered,
    },
    follow_up_bead: followUpBead,
    final_exit_code: finalExitCode,
  };

  persistHistory(options.historyPath, {
    schema_version: FLAKE_HISTORY_SCHEMA_VERSION,
    entries: prunedEntries,
  });
  writeReport(options.reportPath, report);

  process.stderr.write(
    `[flake-gate] classification=${classification} attempts=${attempts.length} recurring=${recurringCount}/${options.flakeThreshold} final_exit=${finalExitCode}\n`,
  );
  if (followUpBead.status === "created" && followUpBead.issue_id) {
    process.stderr.write(`[flake-gate] created follow-up bead ${followUpBead.issue_id}\n`);
  }
  if (followUpBead.status === "existing" && followUpBead.issue_id) {
    process.stderr.write(`[flake-gate] existing follow-up bead ${followUpBead.issue_id}\n`);
  }
  if (followUpBead.status === "error" && followUpBead.message) {
    process.stderr.write(`[flake-gate] warning: ${followUpBead.message}\n`);
  }
  if (followUpBead.status === "skipped" && followUpBead.message) {
    process.stderr.write(`[flake-gate] ${followUpBead.message}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  return finalExitCode;
}

if (import.meta.main) {
  const exitCode = await runE2eFlakeGateCli(process.argv.slice(2));
  process.exit(exitCode);
}
