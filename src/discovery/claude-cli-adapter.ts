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

export type ClaudeCliMessageRole = "system" | "user" | "assistant";

export interface ClaudeCliMessage {
  role: ClaudeCliMessageRole;
  content: string;
}

export interface ClaudeCliInvocationRequest {
  command: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
}

export interface ClaudeCliInvocationSuccess {
  ok: true;
  output: string;
}

export interface ClaudeCliInvocationFailure {
  ok: false;
  exitCode?: number;
  errorType?: "timeout" | "network" | "not_found";
  message: string;
}

export type ClaudeCliInvocationResult =
  | ClaudeCliInvocationSuccess
  | ClaudeCliInvocationFailure;

export type ClaudeCliInvocation = (
  request: ClaudeCliInvocationRequest,
) => Promise<ClaudeCliInvocationResult>;

export interface DispatchToolCallResult {
  envelopes: string[];
}

export type DispatchToolCallsFn = (
  calls: readonly ToolCall<Record<string, unknown>>[],
) => Promise<DispatchToolCallResult>;

export interface ClaudeCliDiscoveryAdapterOptions {
  command: string;
  model?: string;
  availablePaths: string[];
  systemPrompt: string;
  initialUserPrompt: string;
  maxTurns: number;
  timeoutMs: number;
  offlineDiscovery: DiscoveryResult;
  runClaudeCli: ClaudeCliInvocation;
  dispatchToolCalls: DispatchToolCallsFn;
  sleep?: (ms: number) => Promise<void>;
  maxSelectionEntries?: number;
  now?: () => number;
}

export interface ClaudeCliDiscoveryAdapterResult {
  discovery: DiscoveryResult;
  model?: string;
  turns: number;
  turnDurationsMs: number[];
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

function classifyClaudeCliFailure(
  failure: ClaudeCliInvocationFailure,
): LlmFailureKind {
  const message = failure.message.toLowerCase();
  if (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("authentication") ||
    message.includes("auth")
  ) {
    return "auth_error";
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit";
  }
  if (failure.errorType === "timeout") {
    return "agent_timeout";
  }
  if (failure.errorType === "network" || message.includes("network")) {
    return "network_error";
  }
  if (typeof failure.exitCode === "number" && failure.exitCode >= 2) {
    return "server_error";
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

function renderConversationPrompt(
  systemPrompt: string,
  messages: readonly ClaudeCliMessage[],
): string {
  const lines = [
    systemPrompt.trim(),
    "",
    "Conversation history:",
  ];

  for (const message of messages) {
    lines.push(`[${message.role}]`);
    lines.push(message.content);
    lines.push("");
  }

  lines.push("Respond using ctx_tool and ctx_final fenced blocks only.");
  return lines.join("\n");
}

async function resolveFallbackFromState(
  options: ClaudeCliDiscoveryAdapterOptions,
  failure: LlmFailureKind,
  retryCount: number,
  turnsRemaining: number,
  lastSelectGetPayload: unknown | null,
): Promise<{
  done: boolean;
  shouldRetry: boolean;
  delayMs: number;
  result?: ClaudeCliDiscoveryAdapterResult;
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
      fallbackUsed: true,
      warning: resolved.decision.warning,
    },
  };
}

export async function runClaudeCliDiscoveryAdapter(
  options: ClaudeCliDiscoveryAdapterOptions,
): Promise<ClaudeCliDiscoveryAdapterResult> {
  const sleep = options.sleep ?? defaultSleep;
  const messages: ClaudeCliMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.initialUserPrompt },
  ];
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
        retryCountByKind[gate.reason === "timeout" ? "agent_timeout" : "missing_ctx_final"] ??
          0,
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
      };
    }

    if (gate.shouldRequestFinal) {
      messages.push({ role: "user", content: LAST_TURN_CTX_FINAL_MESSAGE });
    }

    const prompt = renderConversationPrompt(options.systemPrompt, messages);
    const turn = turnManager.startTurn();
    const response = await options.runClaudeCli({
      command: options.command,
      model: options.model,
      prompt,
      timeoutMs: options.timeoutMs,
    });
    const timing = turnManager.finishTurn(turn);
    turnDurationsMs.push(timing.durationMs);

    const turnsRemaining = Math.max(
      0,
      options.maxTurns - turnManager.getStats().turnsCompleted,
    );

    if (!response.ok) {
      const failure = classifyClaudeCliFailure(response);
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
      };
    }

    messages.push({ role: "assistant", content: response.output });

    const toolParse = parseCtxToolBlocks(response.output);
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

    const finalBlocks = parseCtxFinalBlocks(response.output);
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
      };
    }
  }
}
