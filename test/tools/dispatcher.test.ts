import { describe, expect, test } from "bun:test";
import { SelectionManager } from "../../src/selection";
import { executeTokenEstimate, validateTokenEstimateArgs } from "../../src/tools/budget-tools";
import { dispatchToolCalls, type ToolHandlerCatalog } from "../../src/tools/dispatcher";
import type { ToolCall } from "../../src/types";

function parseEnvelope(block: string): Record<string, unknown> {
  const match = block.match(/^```ctx_result\n([\s\S]+)\n```$/);
  if (!match || !match[1]) {
    throw new Error("invalid ctx_result envelope");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("tool dispatcher", () => {
  test("returns INVALID_TOOL for unknown tool names", async () => {
    const calls: ToolCall<Record<string, unknown>>[] = [
      { id: "t1", tool: "not_real_tool", args: {} },
    ];

    const dispatched = await dispatchToolCalls(calls, {}, {});
    expect(dispatched.results).toHaveLength(1);
    expect(dispatched.results[0]?.ok).toBe(false);

    const payload = parseEnvelope(dispatched.results[0]!.envelope);
    expect((payload.error as Record<string, unknown>).code).toBe("INVALID_TOOL");
    expect(dispatched.stats.callCount).toBe(1);
    expect(dispatched.stats.byTool.not_real_tool?.callCount).toBe(1);
  });

  test("returns INVALID_ARGS when validator rejects args", async () => {
    const calls: ToolCall<Record<string, unknown>>[] = [
      { id: "t2", tool: "repo_info", args: { bad: true } },
    ];

    const catalog: ToolHandlerCatalog<Record<string, unknown>> = {
      repo_info: {
        validateArgs: () => ({
          ok: false,
          message: "missing required repo_root",
        }),
        execute: () => ({ ok: true }),
      },
    };

    const dispatched = await dispatchToolCalls(calls, catalog, {});
    const payload = parseEnvelope(dispatched.results[0]!.envelope);
    expect((payload.error as Record<string, unknown>).code).toBe("INVALID_ARGS");
    expect((payload.error as Record<string, unknown>).message).toContain("repo_root");
  });

  test("executes known tools, applies truncation, and formats redacted success envelopes", async () => {
    const calls: ToolCall<Record<string, unknown>>[] = [
      { id: "t3", tool: "file_search", args: { pattern: "token" } },
    ];

    const catalog: ToolHandlerCatalog<Record<string, unknown>> = {
      file_search: {
        truncationTool: "file_search",
        execute: () => ({
          pattern: "token",
          mode: "content",
          results: [
            {
              path: "a.ts",
              hits: 2,
              top_excerpts: [
                {
                  line: 10,
                  excerpt: "token ghp_abcdefghijklmnopqrstuvwxyz",
                  match: "ghp_abcdefghijklmnopqrstuvwxyz",
                },
              ],
            },
            {
              path: "b.ts",
              hits: 1,
              top_excerpts: [{ line: 1, excerpt: "second file", match: "file" }],
            },
          ],
        }),
      },
    };

    const dispatched = await dispatchToolCalls(calls, catalog, {}, {
      truncation: {
        fileSearch: {
          maxFiles: 1,
          maxExcerptsPerFile: 1,
          maxExcerptChars: 200,
        },
      },
    });

    const payload = parseEnvelope(dispatched.results[0]!.envelope);
    expect(payload.ok).toBe(true);

    const meta = payload.meta as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect(typeof meta.tokens_estimate).toBe("number");

    const result = payload.result as Record<string, unknown>;
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    const firstExcerpt = ((results[0]?.top_excerpts as Array<Record<string, unknown>>) ?? [])[0];
    expect(firstExcerpt?.excerpt).toContain("‹REDACTED:github_token›");

    expect(dispatched.stats.callCount).toBe(1);
    expect(dispatched.stats.byTool.file_search?.callCount).toBe(1);
    expect(dispatched.stats.tokensReturned).toBeGreaterThan(0);
  });

  test("surfaces INTERNAL_ERROR on executor failure with redacted message", async () => {
    const calls: ToolCall<Record<string, unknown>>[] = [
      { id: "t4", tool: "repo_info", args: {} },
    ];

    const catalog: ToolHandlerCatalog<Record<string, unknown>> = {
      repo_info: {
        execute: () => {
          throw new Error("cannot use postgres://user:password@db.local/app");
        },
      },
    };

    const dispatched = await dispatchToolCalls(calls, catalog, {});
    const payload = parseEnvelope(dispatched.results[0]!.envelope);
    const error = payload.error as Record<string, unknown>;

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toContain("‹REDACTED:postgres_uri_with_credentials›");
  });

  test("dispatches token_estimate with dedicated validator/executor", async () => {
    const calls: ToolCall<Record<string, unknown>>[] = [
      { id: "t5", tool: "token_estimate", args: { text: "abcdefghij" } },
    ];
    const selectionManager = new SelectionManager({
      maxFiles: 10,
      maxFullFiles: 5,
      maxSlicesPerFile: 4,
      maxFileBytes: 1_500_000,
      neverInclude: [],
      excludeBinary: true,
    });

    const catalog: ToolHandlerCatalog<Record<string, unknown>> = {
      token_estimate: {
        validateArgs: validateTokenEstimateArgs,
        execute: (args, context) =>
          executeTokenEstimate(args, {
            repoRoot: context.repoRoot as string,
            selectionManager: context.selectionManager as SelectionManager,
            budgetTokens: context.budgetTokens as number,
            charsPerToken: context.charsPerToken as number,
          }),
      },
    };

    const dispatched = await dispatchToolCalls(calls, catalog, {
      repoRoot: "/repo",
      selectionManager,
      budgetTokens: 1000,
      charsPerToken: 4,
    });
    const payload = parseEnvelope(dispatched.results[0]!.envelope);

    expect(payload.ok).toBe(true);
    expect((payload.result as Record<string, unknown>).tokens).toBe(3);
    expect(dispatched.stats.byTool.token_estimate?.callCount).toBe(1);
  });
});
