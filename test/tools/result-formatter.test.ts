import { describe, expect, test } from "bun:test";
import {
  formatCtxResultError,
  formatCtxResultSuccess,
} from "../../src/tools/result-formatter";

function parseEnvelope(block: string): unknown {
  const match = block.match(/^```ctx_result\n([\s\S]+)\n```$/);
  if (!match || !match[1]) {
    throw new Error("invalid ctx_result block");
  }
  return JSON.parse(match[1]);
}

describe("ctx_result formatter", () => {
  test("formats success result inside ctx_result fence with default meta", () => {
    const block = formatCtxResultSuccess({
      id: "t1",
      result: { path: "src/index.ts", lines: 10 },
    });
    const payload = parseEnvelope(block) as Record<string, unknown>;
    const meta = payload.meta as Record<string, unknown>;

    expect(payload.id).toBe("t1");
    expect(payload.ok).toBe(true);
    expect(payload.result).toEqual({ lines: 10, path: "src/index.ts" });
    expect(meta.truncated).toBe(false);
    expect(typeof meta.tokens_estimate).toBe("number");
    expect(meta.tokens_estimate as number).toBeGreaterThan(0);
  });

  test("uses provided success meta with snake_case tokens field", () => {
    const block = formatCtxResultSuccess({
      id: "t2",
      result: { ok: true },
      meta: {
        truncated: true,
        tokensEstimate: 123.9,
      },
    });
    const payload = parseEnvelope(block) as Record<string, unknown>;

    expect(payload.meta).toEqual({
      truncated: true,
      tokens_estimate: 123,
    });
  });

  test("redacts nested result strings before serialization", () => {
    const block = formatCtxResultSuccess({
      id: "t3",
      result: {
        excerpt: "token ghp_abcdefghijklmnopqrstuvwxyz",
        nested: {
          credential: "postgres://user:password@db.local/app",
        },
      },
    });
    const payload = parseEnvelope(block) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown>;
    const nested = result.nested as Record<string, unknown>;

    expect(result.excerpt).toContain("‹REDACTED:github_token›");
    expect(nested.credential).toContain("‹REDACTED:postgres_uri_with_credentials›");
  });

  test("formats known error code and normalizes unknown codes", () => {
    const known = parseEnvelope(
      formatCtxResultError({
        id: "e1",
        error: {
          code: "NOT_FOUND",
          message: "missing file",
        },
      }),
    ) as Record<string, unknown>;

    const unknown = parseEnvelope(
      formatCtxResultError({
        id: "e2",
        error: {
          code: "CUSTOM_ERROR",
          message: "unexpected",
        },
      }),
    ) as Record<string, unknown>;

    expect((known.error as Record<string, unknown>).code).toBe("NOT_FOUND");
    expect((unknown.error as Record<string, unknown>).code).toBe("INTERNAL_ERROR");
  });

  test("redacts secrets in error messages", () => {
    const payload = parseEnvelope(
      formatCtxResultError({
        id: "e3",
        error: {
          code: "READ_DENIED",
          message: "Bearer abcdefghijklmnopqrstuvwxyz012345 is not allowed",
        },
      }),
    ) as Record<string, unknown>;

    expect((payload.error as Record<string, unknown>).message).toContain(
      "‹REDACTED:bearer_token›",
    );
  });
});
