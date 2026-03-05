import type { ToolCall } from "../types";

const TOOL_BLOCK_PATTERN = /```ctx_tool\s*([\s\S]*?)```/g;

export type ToolCallParseErrorCode =
  | "INVALID_JSON"
  | "INVALID_SHAPE"
  | "INVALID_ARGS";

export interface ToolCallParseError {
  index: number;
  code: ToolCallParseErrorCode;
  message: string;
  rawBlock: string;
}

export interface ToolCallParseResult {
  calls: ToolCall<Record<string, unknown>>[];
  errors: ToolCallParseError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCtxToolBlocks(text: string): ToolCallParseResult {
  const calls: ToolCall<Record<string, unknown>>[] = [];
  const errors: ToolCallParseError[] = [];

  let index = 0;

  for (const match of text.matchAll(TOOL_BLOCK_PATTERN)) {
    index += 1;
    const rawBlock = match[1]?.trim() ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBlock);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "JSON parse failed";
      errors.push({
        index,
        code: "INVALID_JSON",
        message: `Invalid JSON in ctx_tool block: ${detail}`,
        rawBlock,
      });
      continue;
    }

    if (!isRecord(parsed)) {
      errors.push({
        index,
        code: "INVALID_SHAPE",
        message: "ctx_tool JSON must be an object",
        rawBlock,
      });
      continue;
    }

    const id = parsed.id;
    const tool = parsed.tool;
    const rawArgs = parsed.args;

    if (typeof id !== "string" || id.length === 0) {
      errors.push({
        index,
        code: "INVALID_SHAPE",
        message: "ctx_tool block must include non-empty string field: id",
        rawBlock,
      });
      continue;
    }

    if (typeof tool !== "string" || tool.length === 0) {
      errors.push({
        index,
        code: "INVALID_SHAPE",
        message: "ctx_tool block must include non-empty string field: tool",
        rawBlock,
      });
      continue;
    }

    if (rawArgs !== undefined && !isRecord(rawArgs)) {
      errors.push({
        index,
        code: "INVALID_ARGS",
        message: "ctx_tool block args must be an object when provided",
        rawBlock,
      });
      continue;
    }

    calls.push({
      id,
      tool,
      args: rawArgs ?? {},
    });
  }

  return { calls, errors };
}
