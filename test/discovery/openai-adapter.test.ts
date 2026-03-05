import { describe, expect, test } from "bun:test";
import { runOpenAiDiscoveryAdapter, type OpenAiChatResult } from "../../src/discovery/openai-adapter";
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
    "thinking",
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

describe("runOpenAiDiscoveryAdapter", () => {
  test("returns validated discovery when assistant emits ctx_final", async () => {
    const requests: Array<{ messages: string[] }> = [];

    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runChatCompletion: async (request) => {
        requests.push({ messages: request.messages.map((message) => message.content) });
        return {
          ok: true,
          content: ctxFinalBlock("src/main.ts"),
          usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
        };
      },
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
    expect(result.usage.totalTokens).toBe(18);
    expect(requests).toHaveLength(1);
  });

  test("accepts corrected ctx_final when malformed block appears earlier in the same turn", async () => {
    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runChatCompletion: async () => ({
        ok: true,
        content: mixedCtxFinalBlock("src/main.ts"),
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
  });

  test("dispatches tool calls and continues until ctx_final is emitted", async () => {
    const requests: string[] = [];
    const responses: OpenAiChatResult[] = [
      {
        ok: true,
        content: [
          "```ctx_tool",
          JSON.stringify({
            id: "call-1",
            tool: "select_get",
            args: { view: "files" },
          }),
          "```",
        ].join("\n"),
      },
      {
        ok: true,
        content: ctxFinalBlock("src/main.ts"),
      },
    ];
    let callIndex = 0;
    let dispatched = 0;

    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/main.ts", "src/recovered.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runChatCompletion: async (request) => {
        requests.push(request.messages[request.messages.length - 1]?.content ?? "");
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
    expect(requests.some((content) => content.includes("ctx_result"))).toBe(true);
  });

  test("retries 429 once with backoff then succeeds", async () => {
    const responses: OpenAiChatResult[] = [
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

    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runChatCompletion: async () => {
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

    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/main.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runChatCompletion: async () => ({
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
    const responses: OpenAiChatResult[] = [
      {
        ok: true,
        content: [
          "```ctx_tool",
          JSON.stringify({
            id: "call-1",
            tool: "select_get",
            args: { view: "files" },
          }),
          "```",
        ].join("\n"),
      },
      {
        ok: true,
        content: "still thinking",
      },
    ];
    let callIndex = 0;
    const offline = offlineDiscovery(["src/offline.ts"]);

    const result = await runOpenAiDiscoveryAdapter({
      apiKey: "sk-test",
      model: "gpt-4o",
      availablePaths: ["src/recovered.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 1,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runChatCompletion: async (request) => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error(`Unexpected extra request: ${request.messages.length}`);
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
    expect(result.discovery.selection.map((entry) => entry.path)).toEqual([
      "src/recovered.ts",
      "src/offline.ts",
    ]);
    expect(result.warning).toBeDefined();
  });
});
