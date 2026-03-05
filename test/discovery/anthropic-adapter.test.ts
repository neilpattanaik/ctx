import { describe, expect, test } from "bun:test";
import {
  runAnthropicDiscoveryAdapter,
  type AnthropicMessagesResult,
} from "../../src/discovery/anthropic-adapter";
import type { DiscoveryResult } from "../../src/types";

function offlineDiscovery(paths: string[]): DiscoveryResult {
  return {
    openQuestions: [],
    selection: paths.map((path, index) => ({
      path,
      mode: index === 0 ? "full" : "codemap_only",
      priority: index === 0 ? "core" : "ref",
      rationale: "offline fallback",
    })),
    handoffSummary: {
      entrypoints: [],
      keyModules: [],
      dataFlows: [],
      configKnobs: [],
      tests: [],
    },
  };
}

function ctxFinalBlock(path: string): string {
  return [
    "```ctx_final",
    JSON.stringify({
      open_questions: [],
      handoff_summary: {
        entrypoints: [],
        key_modules: [],
        data_flows: [],
        config_knobs: [],
        tests: [],
      },
      selection: [
        {
          path,
          mode: "full",
          priority: "core",
          rationale: "llm final",
        },
      ],
    }),
    "```",
  ].join("\n");
}

function mixedCtxFinalBlock(path: string): string {
  return [
    "analysis",
    "```ctx_final",
    "{not-json}",
    "```",
    "correction",
    ctxFinalBlock(path),
  ].join("\n");
}

function ctxResultEnvelope(callId: string, result: unknown): string {
  return [
    "```ctx_result",
    JSON.stringify({
      id: callId,
      ok: true,
      result,
      meta: { truncated: false, tokens_estimate: 10 },
    }),
    "```",
  ].join("\n");
}

describe("runAnthropicDiscoveryAdapter", () => {
  test("returns validated discovery when assistant emits ctx_final text block", async () => {
    const requests: Array<{ messages: string[]; system: string }> = [];

    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runMessages: async (request) => {
        requests.push({
          messages: request.messages.map((message) => message.content),
          system: request.system,
        });
        return {
          ok: true,
          content: [
            {
              type: "text",
              text: ctxFinalBlock("src/main.ts"),
            },
          ],
          usage: { inputTokens: 13, outputTokens: 8 },
        };
      },
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
    expect(result.usage.promptTokens).toBe(13);
    expect(result.usage.completionTokens).toBe(8);
    expect(result.usage.totalTokens).toBe(21);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toBe("system prompt");
  });

  test("accepts corrected ctx_final when malformed block appears earlier in the same turn", async () => {
    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runMessages: async () => ({
        ok: true,
        content: [
          {
            type: "text",
            text: mixedCtxFinalBlock("src/main.ts"),
          },
        ],
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
  });

  test("dispatches tool calls and continues until ctx_final is emitted", async () => {
    const responses: AnthropicMessagesResult[] = [
      {
        ok: true,
        content: [
          {
            type: "text",
            text: [
              "```ctx_tool",
              JSON.stringify({
                id: "call-1",
                tool: "select_get",
                args: { view: "files" },
              }),
              "```",
            ].join("\n"),
          },
        ],
      },
      {
        ok: true,
        content: ctxFinalBlock("src/main.ts"),
      },
    ];
    let callIndex = 0;
    let dispatched = 0;

    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/main.ts", "src/recovered.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runMessages: async () => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error("Unexpected extra chat request");
        }
        return next;
      },
      dispatchToolCalls: async (calls) => {
        dispatched += 1;
        expect(calls[0]?.tool).toBe("select_get");
        return {
          envelopes: [
            ctxResultEnvelope("call-1", {
              view: "files",
              files: [
                {
                  path: "src/recovered.ts",
                  mode: "full",
                  priority: "core",
                  rationale: "seed",
                },
              ],
            }),
          ],
        };
      },
    });

    expect(dispatched).toBe(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(2);
  });

  test("retries 429 once with backoff then succeeds", async () => {
    const responses: AnthropicMessagesResult[] = [
      {
        ok: false,
        statusCode: 429,
        message: "rate limit",
      },
      {
        ok: true,
        content: ctxFinalBlock("src/main.ts"),
      },
    ];
    const sleepCalls: number[] = [];
    let callIndex = 0;

    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runMessages: async () => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error("Unexpected extra chat request");
        }
        return next;
      },
      dispatchToolCalls: async () => ({ envelopes: [] }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(sleepCalls).toEqual([1000]);
    expect(result.fallbackUsed).toBe(false);
    expect(result.turns).toBe(2);
  });

  test("falls back to offline on auth failure", async () => {
    const offline = offlineDiscovery(["src/offline.ts"]);

    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/main.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runMessages: async () => ({
        ok: false,
        statusCode: 401,
        message: "auth failure",
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.discovery).toEqual(offline);
    expect(result.warning).toContain("auth");
  });

  test("uses hybrid fallback with select_get seeds when ctx_final is never emitted", async () => {
    const responses: AnthropicMessagesResult[] = [
      {
        ok: true,
        content: [
          {
            type: "text",
            text: [
              "```ctx_tool",
              JSON.stringify({
                id: "call-1",
                tool: "select_get",
                args: { view: "files" },
              }),
              "```",
            ].join("\n"),
          },
        ],
      },
      {
        ok: true,
        content: [{ type: "thinking", text: "still thinking" }],
      },
    ];
    let callIndex = 0;
    const offline = offlineDiscovery(["src/offline.ts"]);

    const result = await runAnthropicDiscoveryAdapter({
      apiKey: "sk-ant-test",
      model: "claude-3-7-sonnet-latest",
      availablePaths: ["src/recovered.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 1,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runMessages: async () => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error("Unexpected extra request");
        }
        return next;
      },
      dispatchToolCalls: async () => ({
        envelopes: [
          ctxResultEnvelope("call-1", {
            view: "files",
            files: [
              {
                path: "src/recovered.ts",
                mode: "full",
                priority: "core",
                rationale: "partial",
              },
            ],
          }),
        ],
      }),
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.discovery.selection[0]?.path).toBe("src/recovered.ts");
    expect(result.warning).toContain("ctx_final");
  });
});
