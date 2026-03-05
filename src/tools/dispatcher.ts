import type { RedactionOptions } from "../privacy/redaction";
import type { ToolCall } from "../types";
import {
  formatCtxResultError,
  formatCtxResultSuccess,
} from "./result-formatter";
import {
  enforceDeterministicToolTruncation,
  type ToolTruncationOptions,
  type TruncationSupportedTool,
} from "./truncation";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const KNOWN_TOOL_NAMES = [
  "repo_info",
  "file_tree",
  "list_files",
  "file_search",
  "read_file",
  "read_snippet",
  "codemap",
  "git_status",
  "git_diff",
  "select_add",
  "select_remove",
  "select_get",
  "select_clear",
  "token_estimate",
  "budget_report",
] as const;

const KNOWN_TOOL_NAME_SET = new Set<string>(KNOWN_TOOL_NAMES);

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

export interface ToolArgValidationResultOk {
  ok: true;
}

export interface ToolArgValidationResultErr {
  ok: false;
  message: string;
}

export type ToolArgValidationResult =
  | ToolArgValidationResultOk
  | ToolArgValidationResultErr;

export type ToolArgValidator = (
  args: Record<string, unknown>,
) => ToolArgValidationResult;

export type ToolExecutor<TContext extends Record<string, unknown>> = (
  args: Record<string, unknown>,
  context: TContext,
) => unknown | Promise<unknown>;

export interface ToolHandler<TContext extends Record<string, unknown>> {
  execute: ToolExecutor<TContext>;
  validateArgs?: ToolArgValidator;
  truncationTool?: TruncationSupportedTool;
}

export type ToolHandlerCatalog<TContext extends Record<string, unknown>> =
  Partial<Record<KnownToolName, ToolHandler<TContext>>>;

export interface DispatcherOptions {
  redaction?: RedactionOptions;
  truncation?: ToolTruncationOptions;
}

export interface DispatchExecutionStatsByTool {
  callCount: number;
  totalTimeMs: number;
  tokensReturned: number;
}

export interface DispatchExecutionStats {
  callCount: number;
  totalTimeMs: number;
  tokensReturned: number;
  byTool: Record<string, DispatchExecutionStatsByTool>;
}

export interface DispatchResultItem {
  callId: string;
  tool: string;
  ok: boolean;
  envelope: string;
  elapsedMs: number;
  tokensReturned: number;
}

export interface DispatchToolCallsResult {
  results: DispatchResultItem[];
  stats: DispatchExecutionStats;
}

function isKnownToolName(value: string): value is KnownToolName {
  return KNOWN_TOOL_NAME_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

function estimateTokensFromValue(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return 0;
  }
  return estimateTokensFromText(serialized);
}

function readTruncatedFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const truncation = value.truncation;
  if (!isRecord(truncation)) {
    return false;
  }
  return truncation.truncated === true;
}

function emptyStats(): DispatchExecutionStats {
  return {
    callCount: 0,
    totalTimeMs: 0,
    tokensReturned: 0,
    byTool: {},
  };
}

function updateStats(stats: DispatchExecutionStats, item: DispatchResultItem): void {
  stats.callCount += 1;
  stats.totalTimeMs += item.elapsedMs;
  stats.tokensReturned += item.tokensReturned;

  const existing = stats.byTool[item.tool] ?? {
    callCount: 0,
    totalTimeMs: 0,
    tokensReturned: 0,
  };
  existing.callCount += 1;
  existing.totalTimeMs += item.elapsedMs;
  existing.tokensReturned += item.tokensReturned;
  stats.byTool[item.tool] = existing;
}

async function dispatchOne<TContext extends Record<string, unknown>>(
  call: ToolCall<Record<string, unknown>>,
  catalog: ToolHandlerCatalog<TContext>,
  context: TContext,
  options: DispatcherOptions,
): Promise<DispatchResultItem> {
  const startedAt = Date.now();
  const finish = (ok: boolean, envelope: string): DispatchResultItem => {
    const elapsedMs = Date.now() - startedAt;
    return {
      callId: call.id,
      tool: call.tool,
      ok,
      envelope,
      elapsedMs,
      tokensReturned: estimateTokensFromText(envelope),
    };
  };

  if (!isKnownToolName(call.tool)) {
    return finish(
      false,
      formatCtxResultError(
        {
          id: call.id,
          error: {
            code: "INVALID_TOOL",
            message: `Unknown tool: ${call.tool}`,
          },
        },
        { redaction: options.redaction },
      ),
    );
  }

  const handler = catalog[call.tool];
  if (!handler) {
    return finish(
      false,
      formatCtxResultError(
        {
          id: call.id,
          error: {
            code: "INTERNAL_ERROR",
            message: `Tool handler is not registered: ${call.tool}`,
          },
        },
        { redaction: options.redaction },
      ),
    );
  }

  if (!isRecord(call.args)) {
    return finish(
      false,
      formatCtxResultError(
        {
          id: call.id,
          error: {
            code: "INVALID_ARGS",
            message: "Tool args must be an object",
          },
        },
        { redaction: options.redaction },
      ),
    );
  }

  if (handler.validateArgs) {
    try {
      const validation = handler.validateArgs(call.args);
      if (!validation.ok) {
        return finish(
          false,
          formatCtxResultError(
            {
              id: call.id,
              error: {
                code: "INVALID_ARGS",
                message: validation.message,
              },
            },
            { redaction: options.redaction },
          ),
        );
      }
    } catch (error) {
      return finish(
        false,
        formatCtxResultError(
          {
            id: call.id,
            error: {
              code: "INTERNAL_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Tool arg validation failed",
            },
          },
          { redaction: options.redaction },
        ),
      );
    }
  }

  let resultPayload: unknown;
  try {
    resultPayload = await handler.execute(call.args, context);
  } catch (error) {
    return finish(
      false,
      formatCtxResultError(
        {
          id: call.id,
          error: {
            code: "INTERNAL_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Tool execution failed",
          },
        },
        { redaction: options.redaction },
      ),
    );
  }

  if (handler.truncationTool && isRecord(resultPayload)) {
    resultPayload = enforceDeterministicToolTruncation(
      handler.truncationTool,
      resultPayload as never,
      options.truncation,
    ) as unknown;
  }

  const tokensEstimate = estimateTokensFromValue(resultPayload);
  return finish(
    true,
    formatCtxResultSuccess(
      {
        id: call.id,
        result: resultPayload,
        meta: {
          truncated: readTruncatedFlag(resultPayload),
          tokensEstimate,
        },
      },
      { redaction: options.redaction },
    ),
  );
}

export async function dispatchToolCalls<TContext extends Record<string, unknown>>(
  calls: readonly ToolCall<Record<string, unknown>>[],
  catalog: ToolHandlerCatalog<TContext>,
  context: TContext,
  options: DispatcherOptions = {},
): Promise<DispatchToolCallsResult> {
  const results: DispatchResultItem[] = [];
  const stats = emptyStats();

  for (const call of calls) {
    const item = await dispatchOne(call, catalog, context, options);
    results.push(item);
    updateStats(stats, item);
  }

  return {
    results,
    stats,
  };
}

