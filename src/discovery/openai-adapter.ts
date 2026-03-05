import { parseCtxToolBlocks, type ToolCall } from "../tools";
import { parseCtxFinalBlocks, validateCtxFinalPayload } from "../tools/ctx-final-validator";
import type { DiscoveryResult } from "../types";
import {
  buildSyntheticDiscoveryResultFromSelectGet,
  DiscoveryTurnManager,
  LAST_TURN_CTX_FINAL_MESSAGE,
  type SyntheticDiscoveryFallbackReason,
} from "./turn-manager";
import { resolveFallbackDiscovery, type LlmFailureKind } from "./fallback";

export type OpenAiMessageRole = "system" | "user" | "assistant";

export interface OpenAiChatMessage {
  role: OpenAiMessageRole;
  content: string;
}

export interface OpenAiChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface OpenAiChatSuccess {
  ok: true;
  content: string;
  usage?: OpenAiChatUsage;
}

export interface OpenAiChatFailure {
  ok: false;
  statusCode?: number;
  errorType?: "network" | "timeout";
  message: string;
}

export type OpenAiChatResult = OpenAiChatSuccess | OpenAiChatFailure;

export interface OpenAiChatRequest {
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
}

export type OpenAiChatClient = (request: OpenAiChatRequest) => Promise<OpenAiChatResult>;

export interface DispatchToolCallResult {
  envelopes: string[];
}

export type DispatchToolCallsFn = (
  calls: readonly ToolCall<Record<string, unknown>>[],
) => Promise<DispatchToolCallResult>;

export interface OpenAiDiscoveryAdapterOptions {
  apiKey: string;
  model: string;
  availablePaths: string[];
  systemPrompt: string;
  initialUserPrompt: string;
  maxTurns: number;
  timeoutMs: number;
  offlineDiscovery: DiscoveryResult;
  runChatCompletion: OpenAiChatClient;
  dispatchToolCalls: DispatchToolCallsFn;
  sleep?: (ms: number) => Promise<void>;
  maxSelectionEntries?: number;
  now?: () => number;
}

export interface OpenAiDiscoveryAdapterUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAiDiscoveryAdapterResult {
  discovery: DiscoveryResult;
  model: string;
  turns: number;
  turnDurationsMs: number[];
  usage: OpenAiDiscoveryAdapterUsage;
  fallbackUsed: boolean;
  warning?: string;
}

interface ParsedCtxResult {
  id: string;
  result: unknown;
}

function defaultSleep(_ms: number): Promise<void> {
  return Promise.resolve();
}

function toFallbackReason(kind: LlmFailureKind): SyntheticDiscoveryFallbackReason {
  if (kind === "agent_timeout") {
    return "timeout";
  }
  if (kind === "invalid_ctx_final") {
    return "invalid_ctx_final";
  }
  return "missing_ctx_final";
}

function classifyChatFailure(error: OpenAiChatFailure): LlmFailureKind {
  const statusCode = error.statusCode;
  if (statusCode === 401 || statusCode === 403) {
    return "auth_error";
  }
  if (statusCode === 429) {
    return "rate_limit";
  }
  if (typeof statusCode === "number" && statusCode >= 500) {
    return "server_error";
  }
  if (error.errorType === "timeout") {
    return "agent_timeout";
  }
  if (error.errorType === "network") {
    return "network_error";
  }
  return "unknown_error";
}

function parseCtxResultEnvelope(envelope: string): ParsedCtxResult | null {
  const match = /```ctx_result\s*([\s\S]*?)```/m.exec(envelope);
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as {
      id?: unknown;
      ok?: unknown;
      result?: unknown;
    };
    if (typeof parsed.id !== "string") {
      return null;
    }
    if (parsed.ok !== true) {
      return null;
    }
    return { id: parsed.id, result: parsed.result };
  } catch {
    return null;
  }
}

function describeValidationIssues(
  issues: Array<{ field: string; message: string }>,
): string {
  if (issues.length === 0) {
    return "ctx_final validation failed.";
  }
  const limited = issues.slice(0, 5);
  const body = limited.map((issue) => `- ${issue.field}: ${issue.message}`).join("\n");
  return `ctx_final validation failed. Fix these fields and retry:\n${body}`;
}

function incrementUsage(
  usage: OpenAiDiscoveryAdapterUsage,
  delta: OpenAiChatUsage | undefined,
): void {
  if (!delta) {
    return;
  }
  usage.promptTokens += Math.max(0, Math.floor(delta.promptTokens ?? 0));
  usage.completionTokens += Math.max(0, Math.floor(delta.completionTokens ?? 0));
  usage.totalTokens += Math.max(0, Math.floor(delta.totalTokens ?? 0));
}

function buildPartialDiscoveryFromSelectGet(
  payload: unknown,
  reason: SyntheticDiscoveryFallbackReason,
): DiscoveryResult | null {
  const synthetic = buildSyntheticDiscoveryResultFromSelectGet({
    selectGetPayload: payload,
    reason,
  });
  if (synthetic.extractedSelectionCount < 1) {
    return null;
  }
  return synthetic.discovery;
}

async function resolveFallbackFromState(
  options: OpenAiDiscoveryAdapterOptions,
  failure: LlmFailureKind,
  retryCount: number,
  turnsRemaining: number,
  lastSelectGetPayload: unknown | null,
): Promise<{
  done: boolean;
  shouldRetry: boolean;
  delayMs: number;
  result?: OpenAiDiscoveryAdapterResult;
}> {
  const reason = toFallbackReason(failure);
  const partial = lastSelectGetPayload
    ? buildPartialDiscoveryFromSelectGet(lastSelectGetPayload, reason)
    : null;

  const resolved = resolveFallbackDiscovery({
    failure: {
      kind: failure,
      retryCount,
      turnsRemaining,
    },
    offline: options.offlineDiscovery,
    partial,
    maxSelectionEntries: options.maxSelectionEntries,
  });

  if (resolved.decision.retry.shouldRetry) {
    return {
      done: false,
      shouldRetry: true,
      delayMs: resolved.decision.retry.delayMs,
    };
  }

  return {
    done: true,
    shouldRetry: false,
    delayMs: 0,
    result: {
      discovery: resolved.discovery ?? options.offlineDiscovery,
      model: options.model,
      turns: 0,
      turnDurationsMs: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      fallbackUsed: true,
      warning: resolved.decision.warning,
    },
  };
}

export async function runOpenAiDiscoveryAdapter(
  options: OpenAiDiscoveryAdapterOptions,
): Promise<OpenAiDiscoveryAdapterResult> {
  const sleep = options.sleep ?? defaultSleep;
  const messages: OpenAiChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.initialUserPrompt },
  ];
  const usage: OpenAiDiscoveryAdapterUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const turnManager = new DiscoveryTurnManager({
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  const turnDurationsMs: number[] = [];
  const retryCountByKind: Partial<Record<LlmFailureKind, number>> = {};
  let lastSelectGetPayload: unknown | null = null;

  while (true) {
    const gate = turnManager.gateNextCall();
    if (!gate.allowCall) {
      const timeoutFallback = await resolveFallbackFromState(
        options,
        gate.reason === "timeout" ? "agent_timeout" : "missing_ctx_final",
        retryCountByKind[gate.reason === "timeout" ? "agent_timeout" : "missing_ctx_final"] ?? 0,
        0,
        lastSelectGetPayload,
      );
      if (!timeoutFallback.result) {
        throw new Error("Failed to produce fallback discovery result");
      }
      return {
        ...timeoutFallback.result,
        turns: turnManager.getStats().turnsCompleted,
        turnDurationsMs: [...turnDurationsMs],
        usage: { ...usage },
      };
    }

    if (gate.shouldRequestFinal) {
      messages.push({ role: "user", content: LAST_TURN_CTX_FINAL_MESSAGE });
    }

    const turn = turnManager.startTurn();
    const response = await options.runChatCompletion({
      apiKey: options.apiKey,
      model: options.model,
      messages: messages.map((item) => ({ ...item })),
    });
    const timing = turnManager.finishTurn(turn);
    turnDurationsMs.push(timing.durationMs);

    const turnsRemaining = Math.max(0, options.maxTurns - turnManager.getStats().turnsCompleted);

    if (!response.ok) {
      const failure = classifyChatFailure(response);
      const retryCount = retryCountByKind[failure] ?? 0;
      const fallback = await resolveFallbackFromState(
        options,
        failure,
        retryCount,
        turnsRemaining,
        lastSelectGetPayload,
      );

      if (fallback.shouldRetry) {
        retryCountByKind[failure] = retryCount + 1;
        if (fallback.delayMs > 0) {
          await sleep(fallback.delayMs);
        }
        continue;
      }

      if (!fallback.result) {
        throw new Error("Failed to resolve fallback discovery result");
      }
      return {
        ...fallback.result,
        turns: turnManager.getStats().turnsCompleted,
        turnDurationsMs: [...turnDurationsMs],
        usage: { ...usage },
      };
    }

    incrementUsage(usage, response.usage);
    messages.push({ role: "assistant", content: response.content });

    const toolParse = parseCtxToolBlocks(response.content);
    const calls = toolParse.calls;

    if (calls.length > 0) {
      const dispatch = await options.dispatchToolCalls(calls);
      const selectGetCallIds = new Set(
        calls.filter((call) => call.tool === "select_get").map((call) => call.id),
      );
      for (const envelope of dispatch.envelopes) {
        const parsed = parseCtxResultEnvelope(envelope);
        if (!parsed || !selectGetCallIds.has(parsed.id)) {
          continue;
        }
        lastSelectGetPayload = parsed.result;
      }
      messages.push({ role: "user", content: dispatch.envelopes.join("\n\n") });
    }

    const finalBlocks = parseCtxFinalBlocks(response.content);
    if (finalBlocks.payloads.length > 0 || finalBlocks.errors.length > 0) {
      if (finalBlocks.payloads.length > 0) {
        const validation = validateCtxFinalPayload(
          finalBlocks.payloads[finalBlocks.payloads.length - 1],
          {
            availablePaths: options.availablePaths,
            turnsRemaining,
          },
        );
        if (validation.ok) {
          return {
            discovery: validation.discovery,
            model: options.model,
            turns: turnManager.getStats().turnsCompleted,
            turnDurationsMs: [...turnDurationsMs],
            usage: { ...usage },
            fallbackUsed: false,
          };
        }

        const combinedIssues =
          finalBlocks.errors.length > 0
            ? [...finalBlocks.errors, ...validation.issues]
            : validation.issues;

        if (validation.action === "retry") {
          retryCountByKind.invalid_ctx_final = (retryCountByKind.invalid_ctx_final ?? 0) + 1;
          messages.push({
            role: "user",
            content: describeValidationIssues(combinedIssues),
          });
          continue;
        }

        const fallback = await resolveFallbackFromState(
          options,
          "invalid_ctx_final",
          retryCountByKind.invalid_ctx_final ?? 0,
          turnsRemaining,
          lastSelectGetPayload,
        );
        if (!fallback.result) {
          throw new Error("Failed to resolve fallback after invalid ctx_final");
        }
        return {
          ...fallback.result,
          turns: turnManager.getStats().turnsCompleted,
          turnDurationsMs: [...turnDurationsMs],
          usage: { ...usage },
        };
      }

      const fallback = await resolveFallbackFromState(
        options,
        "invalid_ctx_final",
        retryCountByKind.invalid_ctx_final ?? 0,
        turnsRemaining,
        lastSelectGetPayload,
      );
      if (fallback.shouldRetry) {
        retryCountByKind.invalid_ctx_final =
          (retryCountByKind.invalid_ctx_final ?? 0) + 1;
        messages.push({
          role: "user",
          content: describeValidationIssues(finalBlocks.errors),
        });
        continue;
      }
      if (!fallback.result) {
        throw new Error("Failed to resolve invalid-ctx fallback result");
      }
      return {
        ...fallback.result,
        turns: turnManager.getStats().turnsCompleted,
        turnDurationsMs: [...turnDurationsMs],
        usage: { ...usage },
      };
    }

    if (calls.length === 0) {
      const fallback = await resolveFallbackFromState(
        options,
        "missing_ctx_final",
        retryCountByKind.missing_ctx_final ?? 0,
        turnsRemaining,
        lastSelectGetPayload,
      );
      if (fallback.shouldRetry) {
        retryCountByKind.missing_ctx_final = (retryCountByKind.missing_ctx_final ?? 0) + 1;
        messages.push({
          role: "user",
          content: "No ctx_final block found. Output a valid ctx_final block now.",
        });
        continue;
      }
      if (!fallback.result) {
        throw new Error("Failed to resolve fallback after missing ctx_final");
      }
      return {
        ...fallback.result,
        turns: turnManager.getStats().turnsCompleted,
        turnDurationsMs: [...turnDurationsMs],
        usage: { ...usage },
      };
    }
  }
}
