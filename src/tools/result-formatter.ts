import type { RedactionOptions } from "../privacy/redaction";
import { redactText } from "../privacy/redaction";

export const STANDARD_TOOL_ERROR_CODES = [
  "INVALID_TOOL",
  "READ_DENIED",
  "NOT_FOUND",
  "INVALID_ARGS",
  "BINARY_FILE",
  "SIZE_EXCEEDED",
  "SEARCH_FAILED",
  "PARSE_FAILED",
  "BUDGET_EXCEEDED",
  "INTERNAL_ERROR",
] as const;

export type StandardToolErrorCode = (typeof STANDARD_TOOL_ERROR_CODES)[number];

const STANDARD_TOOL_ERROR_CODE_SET = new Set<string>(STANDARD_TOOL_ERROR_CODES);
const DEFAULT_CHARS_PER_TOKEN = 4;

export interface CtxResultMetaInput {
  truncated?: boolean;
  tokensEstimate?: number;
}

export interface CtxResultError {
  code: string;
  message: string;
}

export interface FormatCtxResultSuccessInput {
  id: string;
  result: unknown;
  meta?: CtxResultMetaInput;
}

export interface FormatCtxResultErrorInput {
  id: string;
  error: CtxResultError;
}

export interface FormatCtxResultOptions {
  redaction?: RedactionOptions;
}

interface SuccessEnvelope {
  id: string;
  ok: true;
  result: unknown;
  meta: {
    truncated: boolean;
    tokens_estimate: number;
  };
}

interface ErrorEnvelope {
  id: string;
  ok: false;
  error: {
    code: StandardToolErrorCode;
    message: string;
  };
}

function redactString(value: string, options?: RedactionOptions): string {
  return redactText(value, options).text;
}

function redactValue(value: unknown, options?: RedactionOptions): unknown {
  if (typeof value === "string") {
    return redactString(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const keys = Object.keys(record).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const key of keys) {
      output[key] = redactValue(record[key], options);
    }
    return output;
  }
  return value;
}

function estimateTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return 0;
  }
  return Math.ceil(serialized.length / DEFAULT_CHARS_PER_TOKEN);
}

function normalizeToolErrorCode(value: string): StandardToolErrorCode {
  if (STANDARD_TOOL_ERROR_CODE_SET.has(value)) {
    return value as StandardToolErrorCode;
  }
  return "INTERNAL_ERROR";
}

function wrapCtxResultEnvelope(payload: SuccessEnvelope | ErrorEnvelope): string {
  return `\`\`\`ctx_result\n${JSON.stringify(payload)}\n\`\`\``;
}

export function formatCtxResultSuccess(
  input: FormatCtxResultSuccessInput,
  options?: FormatCtxResultOptions,
): string {
  const redactedResult = redactValue(input.result, options?.redaction);
  const normalizedMeta = {
    truncated: input.meta?.truncated ?? false,
    tokens_estimate:
      typeof input.meta?.tokensEstimate === "number" &&
      Number.isFinite(input.meta.tokensEstimate) &&
      input.meta.tokensEstimate >= 0
        ? Math.floor(input.meta.tokensEstimate)
        : estimateTokens(redactedResult),
  };

  return wrapCtxResultEnvelope({
    id: input.id,
    ok: true,
    result: redactedResult,
    meta: normalizedMeta,
  });
}

export function formatCtxResultError(
  input: FormatCtxResultErrorInput,
  options?: FormatCtxResultOptions,
): string {
  return wrapCtxResultEnvelope({
    id: input.id,
    ok: false,
    error: {
      code: normalizeToolErrorCode(input.error.code),
      message: redactString(input.error.message, options?.redaction),
    },
  });
}
