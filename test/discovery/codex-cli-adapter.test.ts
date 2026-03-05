import { describe, expect, test } from "bun:test";
import {
  runCodexCliDiscoveryAdapter,
  type CodexCliInvocationRequest,
} from "../../src/discovery/codex-cli-adapter";
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

describe("runCodexCliDiscoveryAdapter", () => {
  test("returns validated discovery when output contains ctx_final", async () => {
    const requests: CodexCliInvocationRequest[] = [];

    const result = await runCodexCliDiscoveryAdapter({
      command: "codex",
      model: "gpt-5-codex",
      availablePaths: ["src/main.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runCodexCli: async (request) => {
        requests.push(request);
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
    expect(requests[0]?.command).toBe("codex");
  });

  test("dispatches tool calls and continues until ctx_final is emitted", async () => {
    const responses = [
      {
        ok: true as const,
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
        ok: true as const,
        output: ctxFinalBlock("src/main.ts"),
      },
    ];
    let callIndex = 0;
    let dispatched = 0;

    const result = await runCodexCliDiscoveryAdapter({
      command: "codex",
      model: "gpt-5-codex",
      availablePaths: ["src/main.ts", "src/recovered.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offlineDiscovery(["src/offline.ts"]),
      runCodexCli: async () => {
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

  test("falls back to offline on auth failure", async () => {
    const offline = offlineDiscovery(["src/offline.ts"]);

    const result = await runCodexCliDiscoveryAdapter({
      command: "codex",
      model: "gpt-5-codex",
      availablePaths: ["src/main.ts", "src/offline.ts"],
      systemPrompt: "system prompt",
      initialUserPrompt: "user prompt",
      maxTurns: 4,
      timeoutMs: 60_000,
      offlineDiscovery: offline,
      runCodexCli: async () => ({
        ok: false,
        message: "authentication failed",
      }),
      dispatchToolCalls: async () => ({ envelopes: [] }),
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.discovery).toEqual(offline);
    expect(result.warning).toContain("auth");
  });
});
