import { describe, expect, test } from "bun:test";
import {
  runClaudeCliDiscoveryAdapter,
  type ClaudeCliInvocationResult,
} from "../../src/discovery/claude-cli-adapter";
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

describe("runClaudeCliDiscoveryAdapter", () => {
  test("returns validated discovery when output contains ctx_final", async () => {
    const prompts: string[] = [];

    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runClaudeCli: async (request) => {
        prompts.push(request.prompt);
        return {
          ok: true,
          output: ctxFinalBlock("src/main.ts"),
        };
      },
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
    expect(prompts[0]).toContain("Conversation history:");
  });

  test("accepts corrected ctx_final when malformed block appears earlier in the same output", async () => {
    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runClaudeCli: async () => ({
        ok: true,
        output: mixedCtxFinalBlock("src/main.ts"),
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(false);
    expect(result.discovery.selection[0]?.path).toBe("src/main.ts");
    expect(result.turns).toBe(1);
  });

  test("dispatches tool calls and continues until ctx_final is emitted", async () => {
    const responses: ClaudeCliInvocationResult[] = [
      {
        ok: true,
        output: [
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
        output: ctxFinalBlock("src/main.ts"),
      },
    ];
    let callIndex = 0;
    let dispatched = 0;

    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/main.ts", "src/recovered.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runClaudeCli: async () => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error("Unexpected extra request");
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

  test("retries rate-limit failure once with backoff then succeeds", async () => {
    const responses: ClaudeCliInvocationResult[] = [
      {
        ok: false,
        message: "Rate limit exceeded",
      },
      {
        ok: true,
        output: ctxFinalBlock("src/main.ts"),
      },
    ];
    const sleepCalls: number[] = [];
    let callIndex = 0;

    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runClaudeCli: async () => {
        const next = responses[callIndex];
        callIndex += 1;
        if (!next) {
          throw new Error("Unexpected extra request");
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

    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/main.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runClaudeCli: async () => ({
        ok: false,
        message: "authentication failed",
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.discovery).toEqual(offline);
    expect(result.warning).toContain("auth");
  });

  test("uses hybrid fallback with select_get seeds when ctx_final is never emitted", async () => {
    const responses: ClaudeCliInvocationResult[] = [
      {
        ok: true,
        output: [
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
        output: "still thinking",
      },
    ];
    let callIndex = 0;
    const offline = offlineDiscovery(["src/offline.ts"]);

    const result = await runClaudeCliDiscoveryAdapter({
      command: "claude",
      model: "sonnet",
      availablePaths: ["src/recovered.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 1,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runClaudeCli: async () => {
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
