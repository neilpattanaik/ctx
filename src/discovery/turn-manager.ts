import type { DiscoveryResult, SelectionEntry } from "../types";
import { stableSort } from "../utils/deterministic";

const DEFAULT_PER_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ENTRYPOINTS = 8;
const DEFAULT_MAX_KEY_MODULES = 12;
const DEFAULT_MAX_TEST_FILES = 8;

const ENTRYPOINT_PATH_PATTERN =
  /(^|\/)(main|index|app|server|routes?|cli)\.[a-z0-9]+$/i;

export const LAST_TURN_CTX_FINAL_MESSAGE =
  "This is your LAST turn. Please output your ctx_final block now.";

export type TurnLimitReason = "turn_limit" | "timeout";

export interface DiscoveryTurnManagerOptions {
  maxTurns: number;
  timeoutMs: number;
  perCallTimeoutMs?: number;
  now?: () => number;
}

export interface TurnGateDecision {
  allowCall: boolean;
  shouldRequestFinal: boolean;
  reason?: TurnLimitReason;
  message?: string;
  elapsedMs: number;
  timeRemainingMs: number;
  turnsCompleted: number;
}

export interface TurnTiming {
  turn: number;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
}

export interface TurnHandle {
  turn: number;
  startedAtMs: number;
}

export interface DiscoveryTurnStats {
  turnsCompleted: number;
  elapsedMs: number;
  timeRemainingMs: number;
  timedOut: boolean;
  totalTurnTimeMs: number;
  turnTimings: TurnTiming[];
}

export type SyntheticDiscoveryFallbackReason =
  | "turn_limit"
  | "timeout"
  | "invalid_ctx_final"
  | "missing_ctx_final";

export interface SyntheticDiscoveryResultOptions {
  selection: readonly SelectionEntry[];
  reason: SyntheticDiscoveryFallbackReason;
  warningPrefix?: string;
  maxEntrypoints?: number;
  maxKeyModules?: number;
  maxTests?: number;
}

export interface SyntheticDiscoveryFromSelectGetOptions
  extends Omit<SyntheticDiscoveryResultOptions, "selection"> {
  selectGetPayload: unknown;
}

type UnknownRecord = Record<string, unknown>;
const VALID_SELECTION_MODES = new Set<SelectionEntry["mode"]>([
  "full",
  "slices",
  "codemap_only",
]);
const VALID_SELECTION_PRIORITIES = new Set<SelectionEntry["priority"]>([
  "core",
  "support",
  "ref",
]);
const SELECT_GET_FALLBACK_RATIONALE = "recovered from select_get files view";

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1`);
  }
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readMode(value: unknown): SelectionEntry["mode"] | null {
  if (typeof value !== "string" || !VALID_SELECTION_MODES.has(value as SelectionEntry["mode"])) {
    return null;
  }
  return value as SelectionEntry["mode"];
}

function readPriority(value: unknown): SelectionEntry["priority"] {
  if (
    typeof value === "string" &&
    VALID_SELECTION_PRIORITIES.has(value as SelectionEntry["priority"])
  ) {
    return value as SelectionEntry["priority"];
  }
  return "support";
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isTestPath(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  return (
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.js")
  );
}

function fallbackReasonLabel(reason: SyntheticDiscoveryFallbackReason): string {
  switch (reason) {
    case "turn_limit":
      return "turn limit reached before valid ctx_final";
    case "timeout":
      return "discovery timeout reached before valid ctx_final";
    case "invalid_ctx_final":
      return "agent emitted invalid ctx_final and retries were exhausted";
    case "missing_ctx_final":
      return "agent did not emit ctx_final";
    default:
      return "discovery fallback";
  }
}

function priorityWeight(entry: SelectionEntry): number {
  if (entry.priority === "core") {
    return 0;
  }
  if (entry.priority === "support") {
    return 1;
  }
  return 2;
}

function stableSelectionOrder(
  selection: readonly SelectionEntry[],
): SelectionEntry[] {
  return stableSort(
    selection.map((entry) => ({
      ...entry,
      path: normalizePath(entry.path),
    })),
    (left, right) => {
      const leftPriority = priorityWeight(left);
      const rightPriority = priorityWeight(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      if (left.mode !== right.mode) {
        return left.mode.localeCompare(right.mode);
      }
      return left.path.localeCompare(right.path);
    },
  );
}

function extractSlicesFromSelectGetEntry(
  value: unknown,
  fallbackRationale: string,
): SelectionEntry["slices"] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const slices: SelectionEntry["slices"] = [];
  for (const rawSlice of value) {
    if (!isRecord(rawSlice)) {
      continue;
    }

    const startLine = readPositiveIntegerOrNull(rawSlice.start_line ?? rawSlice.startLine);
    const endLine = readPositiveIntegerOrNull(rawSlice.end_line ?? rawSlice.endLine);
    if (startLine === null || endLine === null || endLine < startLine) {
      continue;
    }

    const description =
      typeof rawSlice.description === "string" && rawSlice.description.trim().length > 0
        ? rawSlice.description
        : "slice";
    const rationale =
      typeof rawSlice.rationale === "string" && rawSlice.rationale.trim().length > 0
        ? rawSlice.rationale
        : fallbackRationale;

    slices.push({
      startLine,
      endLine,
      description,
      rationale,
    });
  }

  return slices.length > 0 ? slices : null;
}

export function extractSelectionFromSelectGetPayload(
  payload: unknown,
): SelectionEntry[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (payload.view !== "files" || !Array.isArray(payload.files)) {
    return [];
  }

  const extracted: SelectionEntry[] = [];
  const seenPaths = new Set<string>();
  for (const item of payload.files) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item.path !== "string" || item.path.trim().length === 0) {
      continue;
    }
    const path = normalizePath(item.path);
    if (seenPaths.has(path)) {
      continue;
    }

    const mode = readMode(item.mode);
    if (mode === null) {
      continue;
    }

    const priority = readPriority(item.priority);
    const rationale =
      typeof item.rationale === "string" && item.rationale.trim().length > 0
        ? item.rationale
        : SELECT_GET_FALLBACK_RATIONALE;

    if (mode === "slices") {
      const slices = extractSlicesFromSelectGetEntry(item.slices, rationale);
      if (slices !== null) {
        extracted.push({
          path,
          mode: "slices",
          priority,
          rationale,
          slices,
        });
      } else {
        extracted.push({
          path,
          mode: "codemap_only",
          priority,
          rationale: `${rationale}; slices unavailable during fallback`,
        });
      }
      seenPaths.add(path);
      continue;
    }

    extracted.push({
      path,
      mode,
      priority,
      rationale,
    });
    seenPaths.add(path);
  }

  return extracted;
}

export class DiscoveryTurnManager {
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly perCallTimeoutMs: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly turnTimings: TurnTiming[] = [];
  private completedTurns = 0;
  private finalWarningIssuedFor: TurnLimitReason | null = null;
  private activeTurn: TurnHandle | null = null;

  constructor(options: DiscoveryTurnManagerOptions) {
    this.maxTurns = readPositiveInteger(options.maxTurns, "maxTurns");
    this.timeoutMs = readPositiveInteger(options.timeoutMs, "timeoutMs");
    const defaultPerCallTimeoutMs = Math.max(
      1,
      Math.min(DEFAULT_PER_CALL_TIMEOUT_MS, Math.floor(this.timeoutMs / 2)),
    );
    this.perCallTimeoutMs = readPositiveInteger(
      options.perCallTimeoutMs ?? defaultPerCallTimeoutMs,
      "perCallTimeoutMs",
    );
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  gateNextCall(): TurnGateDecision {
    const elapsedMs = Math.max(0, this.now() - this.startedAtMs);
    const timeRemainingMs = Math.max(0, this.timeoutMs - elapsedMs);
    const timeoutReached = elapsedMs >= this.timeoutMs;
    const timeoutApproaching = timeRemainingMs <= this.perCallTimeoutMs;
    const turnLimitReached = this.completedTurns >= this.maxTurns;

    if (this.finalWarningIssuedFor !== null) {
      return {
        allowCall: false,
        shouldRequestFinal: false,
        reason: this.finalWarningIssuedFor,
        elapsedMs,
        timeRemainingMs,
        turnsCompleted: this.completedTurns,
      };
    }

    if (turnLimitReached) {
      this.finalWarningIssuedFor = "turn_limit";
      return {
        allowCall: true,
        shouldRequestFinal: true,
        reason: "turn_limit",
        message: LAST_TURN_CTX_FINAL_MESSAGE,
        elapsedMs,
        timeRemainingMs,
        turnsCompleted: this.completedTurns,
      };
    }

    if (timeoutReached || timeoutApproaching) {
      this.finalWarningIssuedFor = "timeout";
      return {
        allowCall: true,
        shouldRequestFinal: true,
        reason: "timeout",
        message: LAST_TURN_CTX_FINAL_MESSAGE,
        elapsedMs,
        timeRemainingMs,
        turnsCompleted: this.completedTurns,
      };
    }

    return {
      allowCall: true,
      shouldRequestFinal: false,
      elapsedMs,
      timeRemainingMs,
      turnsCompleted: this.completedTurns,
    };
  }

  startTurn(): TurnHandle {
    if (this.activeTurn !== null) {
      throw new Error("A discovery turn is already in progress");
    }
    const handle: TurnHandle = {
      turn: this.completedTurns + 1,
      startedAtMs: this.now(),
    };
    this.activeTurn = handle;
    return { ...handle };
  }

  finishTurn(handle?: TurnHandle): TurnTiming {
    const resolvedHandle = handle ?? this.activeTurn;
    if (resolvedHandle === null) {
      throw new Error("No active discovery turn to finish");
    }
    if (resolvedHandle.turn !== this.completedTurns + 1) {
      throw new Error("Turn handle does not match expected sequence");
    }

    const finishedAtMs = this.now();
    if (finishedAtMs < resolvedHandle.startedAtMs) {
      throw new Error("Turn finish time must be >= start time");
    }

    const timing: TurnTiming = {
      turn: resolvedHandle.turn,
      startedAtMs: resolvedHandle.startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - resolvedHandle.startedAtMs,
    };

    this.turnTimings.push(timing);
    this.completedTurns += 1;
    this.activeTurn = null;
    return { ...timing };
  }

  getStats(): DiscoveryTurnStats {
    const elapsedMs = Math.max(0, this.now() - this.startedAtMs);
    const timeRemainingMs = Math.max(0, this.timeoutMs - elapsedMs);
    const turnTimings = this.turnTimings.map((timing) => ({ ...timing }));
    const totalTurnTimeMs = turnTimings.reduce(
      (sum, timing) => sum + timing.durationMs,
      0,
    );

    return {
      turnsCompleted: this.completedTurns,
      elapsedMs,
      timeRemainingMs,
      timedOut: elapsedMs >= this.timeoutMs,
      totalTurnTimeMs,
      turnTimings,
    };
  }
}

export function buildSyntheticDiscoveryResult(
  options: SyntheticDiscoveryResultOptions,
): { discovery: DiscoveryResult; warning: string } {
  const maxEntrypoints = readPositiveInteger(
    options.maxEntrypoints ?? DEFAULT_MAX_ENTRYPOINTS,
    "maxEntrypoints",
  );
  const maxKeyModules = readPositiveInteger(
    options.maxKeyModules ?? DEFAULT_MAX_KEY_MODULES,
    "maxKeyModules",
  );
  const maxTests = readPositiveInteger(options.maxTests ?? DEFAULT_MAX_TEST_FILES, "maxTests");

  const orderedSelection = stableSelectionOrder(options.selection);

  const entrypoints = orderedSelection
    .filter((entry) => ENTRYPOINT_PATH_PATTERN.test(entry.path))
    .slice(0, maxEntrypoints)
    .map((entry) => ({
      path: entry.path,
      notes: `derived from partial selection (${entry.mode})`,
    }));

  const keyModules = orderedSelection
    .filter((entry) => !ENTRYPOINT_PATH_PATTERN.test(entry.path))
    .slice(0, maxKeyModules)
    .map((entry) => ({
      path: entry.path,
      notes: `derived from partial selection (${entry.priority})`,
    }));

  const tests = orderedSelection
    .filter((entry) => isTestPath(entry.path))
    .slice(0, maxTests)
    .map((entry) => ({
      path: entry.path,
      notes: "test file observed in partial selection",
    }));

  const reasonText = fallbackReasonLabel(options.reason);
  const warningPrefix = options.warningPrefix?.trim();
  const warning = warningPrefix
    ? `${warningPrefix}: ${reasonText}`
    : `Discovery fallback: ${reasonText}`;

  return {
    discovery: {
      openQuestions: [],
      selection: orderedSelection,
      handoffSummary: {
        entrypoints,
        keyModules,
        dataFlows: [],
        configKnobs: [],
        tests,
      },
    },
    warning,
  };
}

export function buildSyntheticDiscoveryResultFromSelectGet(
  options: SyntheticDiscoveryFromSelectGetOptions,
): { discovery: DiscoveryResult; warning: string; extractedSelectionCount: number } {
  const extractedSelection = extractSelectionFromSelectGetPayload(options.selectGetPayload);
  const synthetic = buildSyntheticDiscoveryResult({
    selection: extractedSelection,
    reason: options.reason,
    warningPrefix: options.warningPrefix,
    maxEntrypoints: options.maxEntrypoints,
    maxKeyModules: options.maxKeyModules,
    maxTests: options.maxTests,
  });

  return {
    ...synthetic,
    extractedSelectionCount: extractedSelection.length,
  };
}
