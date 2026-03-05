import type {
  ConfigKnobNote,
  DataFlowNote,
  DiscoveryResult,
  OpenQuestion,
  PathNote,
  SelectionEntry,
} from "../types";
import { stableSort } from "../utils/deterministic";
import {
  buildSyntheticDiscoveryResultFromSelectGet,
  type SyntheticDiscoveryFallbackReason,
} from "./turn-manager";

const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000] as const;

export type LlmFailureKind =
  | "missing_api_key"
  | "auth_error"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "agent_timeout"
  | "invalid_ctx_final"
  | "missing_ctx_final"
  | "unknown_error";

export interface LlmFallbackInput {
  kind: LlmFailureKind;
  retryCount?: number;
  turnsRemaining?: number;
}

export interface LlmRetryDirective {
  shouldRetry: boolean;
  delayMs: number;
  maxRetries: number;
}

export type LlmFallbackStrategy = "offline" | "hybrid";

export interface LlmFallbackDecision {
  kind: LlmFailureKind;
  strategy: LlmFallbackStrategy;
  retry: LlmRetryDirective;
  warning: string;
}

export interface MergeDiscoveryOptions {
  partial: DiscoveryResult;
  offline: DiscoveryResult;
  maxSelectionEntries?: number;
}

export interface ResolveFallbackDiscoveryOptions {
  failure: LlmFallbackInput;
  offline: DiscoveryResult;
  partial?: DiscoveryResult | null;
  selectGetPayload?: unknown;
  maxSelectionEntries?: number;
}

export interface ResolveFallbackDiscoveryResult {
  decision: LlmFallbackDecision;
  discovery?: DiscoveryResult;
  warning?: string;
}

function readNonNegativeInteger(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function cloneSelectionEntry(entry: SelectionEntry): SelectionEntry {
  if (entry.mode === "slices") {
    return {
      ...entry,
      slices: entry.slices.map((slice) => ({ ...slice })),
      path: normalizePath(entry.path),
    };
  }

  return {
    ...entry,
    path: normalizePath(entry.path),
  };
}

function selectionPriorityWeight(entry: SelectionEntry): number {
  if (entry.priority === "core") {
    return 0;
  }
  if (entry.priority === "support") {
    return 1;
  }
  return 2;
}

function selectionModeWeight(entry: SelectionEntry): number {
  if (entry.mode === "full") {
    return 0;
  }
  if (entry.mode === "slices") {
    return 1;
  }
  return 2;
}

function normalizeSelection(
  selection: readonly SelectionEntry[],
): SelectionEntry[] {
  const deduped = new Map<string, SelectionEntry>();
  const ordered = stableSort(
    selection.map((entry) => cloneSelectionEntry(entry)),
    (left, right) => {
      const priorityDiff = selectionPriorityWeight(left) - selectionPriorityWeight(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const modeDiff = selectionModeWeight(left) - selectionModeWeight(right);
      if (modeDiff !== 0) {
        return modeDiff;
      }
      return left.path.localeCompare(right.path);
    },
  );

  for (const entry of ordered) {
    if (!deduped.has(entry.path)) {
      deduped.set(entry.path, entry);
    }
  }

  return [...deduped.values()];
}

function mergePathNotes(
  partial: readonly PathNote[],
  offline: readonly PathNote[],
): PathNote[] {
  const merged = new Map<string, PathNote>();
  for (const item of [...partial, ...offline]) {
    const path = normalizePath(item.path);
    if (!merged.has(path)) {
      merged.set(path, { path, notes: item.notes });
    }
  }
  return stableSort([...merged.values()], (left, right) => left.path.localeCompare(right.path));
}

function mergeDataFlows(
  partial: readonly DataFlowNote[],
  offline: readonly DataFlowNote[],
): DataFlowNote[] {
  const merged = new Map<string, DataFlowNote>();
  for (const item of [...partial, ...offline]) {
    if (!merged.has(item.name)) {
      merged.set(item.name, { ...item });
    }
  }
  return stableSort([...merged.values()], (left, right) => left.name.localeCompare(right.name));
}

function mergeConfigKnobs(
  partial: readonly ConfigKnobNote[],
  offline: readonly ConfigKnobNote[],
): ConfigKnobNote[] {
  const merged = new Map<string, ConfigKnobNote>();
  for (const item of [...partial, ...offline]) {
    const key = `${item.key}::${item.where}`;
    if (!merged.has(key)) {
      merged.set(key, { ...item });
    }
  }
  return stableSort(
    [...merged.values()],
    (left, right) =>
      left.key === right.key
        ? left.where.localeCompare(right.where)
        : left.key.localeCompare(right.key),
  );
}

function mergeOpenQuestions(
  partial: readonly OpenQuestion[],
  offline: readonly OpenQuestion[],
): OpenQuestion[] {
  const merged = new Map<string, OpenQuestion>();
  for (const item of [...partial, ...offline]) {
    if (!merged.has(item.question)) {
      merged.set(item.question, { ...item });
    }
  }
  return stableSort(
    [...merged.values()],
    (left, right) => left.question.localeCompare(right.question),
  );
}

function mergeSelections(
  partial: readonly SelectionEntry[],
  offline: readonly SelectionEntry[],
  maxSelectionEntries: number | undefined,
): SelectionEntry[] {
  const partialNormalized = normalizeSelection(partial);
  const offlineNormalized = normalizeSelection(offline);
  const merged = [...partialNormalized];
  const selectedPaths = new Set<string>(partialNormalized.map((entry) => entry.path));

  for (const entry of offlineNormalized) {
    if (selectedPaths.has(entry.path)) {
      continue;
    }
    merged.push(entry);
    selectedPaths.add(entry.path);
  }

  const cap = readNonNegativeInteger(maxSelectionEntries);
  if (cap < 1) {
    return merged;
  }
  return merged.slice(0, cap);
}

function cloneDiscoveryResult(discovery: DiscoveryResult): DiscoveryResult {
  return {
    openQuestions: discovery.openQuestions.map((item) => ({ ...item })),
    selection: discovery.selection.map((entry) => cloneSelectionEntry(entry)),
    handoffSummary: {
      entrypoints: discovery.handoffSummary.entrypoints.map((item) => ({
        ...item,
        path: normalizePath(item.path),
      })),
      keyModules: discovery.handoffSummary.keyModules.map((item) => ({
        ...item,
        path: normalizePath(item.path),
      })),
      dataFlows: discovery.handoffSummary.dataFlows.map((item) => ({ ...item })),
      configKnobs: discovery.handoffSummary.configKnobs.map((item) => ({ ...item })),
      tests: discovery.handoffSummary.tests.map((item) => ({
        ...item,
        path: normalizePath(item.path),
      })),
    },
  };
}

function toSyntheticReason(kind: LlmFailureKind): SyntheticDiscoveryFallbackReason {
  switch (kind) {
    case "agent_timeout":
      return "timeout";
    case "invalid_ctx_final":
      return "invalid_ctx_final";
    case "missing_ctx_final":
      return "missing_ctx_final";
    default:
      return "missing_ctx_final";
  }
}

function buildPartialFromSelectGet(
  options: ResolveFallbackDiscoveryOptions,
): { partial: DiscoveryResult | null; warning?: string } {
  if (options.selectGetPayload === undefined) {
    return { partial: null };
  }

  const synthetic = buildSyntheticDiscoveryResultFromSelectGet({
    selectGetPayload: options.selectGetPayload,
    reason: toSyntheticReason(options.failure.kind),
    warningPrefix: "LLM fallback",
  });

  if (synthetic.extractedSelectionCount < 1) {
    return { partial: null };
  }

  return {
    partial: synthetic.discovery,
    warning: synthetic.warning,
  };
}

export function evaluateLlmFallback(input: LlmFallbackInput): LlmFallbackDecision {
  const retryCount = readNonNegativeInteger(input.retryCount);
  const turnsRemaining = readNonNegativeInteger(input.turnsRemaining);

  switch (input.kind) {
    case "missing_api_key":
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM discovery unavailable: API key is missing; falling back to offline.",
      };
    case "auth_error":
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM discovery auth failed; falling back to offline discovery.",
      };
    case "rate_limit": {
      const maxRetries = RATE_LIMIT_BACKOFF_MS.length;
      if (retryCount < maxRetries) {
        return {
          kind: input.kind,
          strategy: "offline",
          retry: {
            shouldRetry: true,
            delayMs: RATE_LIMIT_BACKOFF_MS[retryCount],
            maxRetries,
          },
          warning: `LLM discovery rate-limited; retrying (${retryCount + 1}/${maxRetries}).`,
        };
      }
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries },
        warning: "LLM discovery rate-limited after retries; falling back to offline.",
      };
    }
    case "server_error": {
      const maxRetries = 1;
      if (retryCount < maxRetries) {
        return {
          kind: input.kind,
          strategy: "offline",
          retry: { shouldRetry: true, delayMs: 1000, maxRetries },
          warning: "LLM discovery server error; retrying once before fallback.",
        };
      }
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries },
        warning: "LLM discovery server error persisted; falling back to offline.",
      };
    }
    case "network_error":
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM discovery network failure; falling back to offline discovery.",
      };
    case "agent_timeout":
      return {
        kind: input.kind,
        strategy: "hybrid",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM discovery timed out; merging partial LLM selection with offline ranking.",
      };
    case "invalid_ctx_final":
      if (turnsRemaining > 0) {
        return {
          kind: input.kind,
          strategy: "hybrid",
          retry: { shouldRetry: true, delayMs: 0, maxRetries: turnsRemaining },
          warning: "LLM returned invalid ctx_final; requesting retry.",
        };
      }
      return {
        kind: input.kind,
        strategy: "hybrid",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM returned invalid ctx_final with no turns remaining; using hybrid fallback.",
      };
    case "missing_ctx_final":
      if (turnsRemaining > 0) {
        return {
          kind: input.kind,
          strategy: "hybrid",
          retry: { shouldRetry: true, delayMs: 0, maxRetries: turnsRemaining },
          warning: "LLM did not emit ctx_final; requesting retry.",
        };
      }
      return {
        kind: input.kind,
        strategy: "hybrid",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM did not emit ctx_final with no turns remaining; using hybrid fallback.",
      };
    case "unknown_error":
    default:
      return {
        kind: input.kind,
        strategy: "offline",
        retry: { shouldRetry: false, delayMs: 0, maxRetries: 0 },
        warning: "LLM discovery failed unexpectedly; falling back to offline discovery.",
      };
  }
}

export function mergePartialAndOfflineDiscovery(
  options: MergeDiscoveryOptions,
): DiscoveryResult {
  const partial = cloneDiscoveryResult(options.partial);
  const offline = cloneDiscoveryResult(options.offline);
  const mergedSelection = mergeSelections(
    partial.selection,
    offline.selection,
    options.maxSelectionEntries,
  );

  return {
    selection: mergedSelection,
    openQuestions: mergeOpenQuestions(partial.openQuestions, offline.openQuestions),
    handoffSummary: {
      entrypoints: mergePathNotes(
        partial.handoffSummary.entrypoints,
        offline.handoffSummary.entrypoints,
      ),
      keyModules: mergePathNotes(
        partial.handoffSummary.keyModules,
        offline.handoffSummary.keyModules,
      ),
      dataFlows: mergeDataFlows(
        partial.handoffSummary.dataFlows,
        offline.handoffSummary.dataFlows,
      ),
      configKnobs: mergeConfigKnobs(
        partial.handoffSummary.configKnobs,
        offline.handoffSummary.configKnobs,
      ),
      tests: mergePathNotes(partial.handoffSummary.tests, offline.handoffSummary.tests),
    },
  };
}

export function resolveFallbackDiscovery(
  options: ResolveFallbackDiscoveryOptions,
): ResolveFallbackDiscoveryResult {
  const decision = evaluateLlmFallback(options.failure);
  if (decision.retry.shouldRetry) {
    return { decision };
  }

  const partialHasSelection = Boolean(
    options.partial && options.partial.selection.length > 0,
  );
  if (decision.strategy === "hybrid" && partialHasSelection) {
    return {
      decision,
      discovery: mergePartialAndOfflineDiscovery({
        partial: options.partial as DiscoveryResult,
        offline: options.offline,
        maxSelectionEntries: options.maxSelectionEntries,
      }),
    };
  }

  if (decision.strategy === "hybrid" && !partialHasSelection) {
    const selectGetPartial = buildPartialFromSelectGet(options);
    if (selectGetPartial.partial && selectGetPartial.partial.selection.length > 0) {
      return {
        decision,
        warning: selectGetPartial.warning,
        discovery: mergePartialAndOfflineDiscovery({
          partial: selectGetPartial.partial,
          offline: options.offline,
          maxSelectionEntries: options.maxSelectionEntries,
        }),
      };
    }
  }

  return {
    decision,
    discovery: cloneDiscoveryResult(options.offline),
  };
}
