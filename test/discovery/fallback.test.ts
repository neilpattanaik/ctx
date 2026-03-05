import { describe, expect, test } from "bun:test";
import {
  evaluateLlmFallback,
  mergePartialAndOfflineDiscovery,
  resolveFallbackDiscovery,
} from "../../src/discovery/fallback";
import type { DiscoveryResult } from "../../src/types";

function createDiscoveryResult(selectionPaths: string[]): DiscoveryResult {
  return {
    openQuestions: [],
    selection: selectionPaths.map((path, index) => ({
      path,
      mode: index === 0 ? "full" : index === 1 ? "slices" : "codemap_only",
      priority: index === 0 ? "core" : index === 1 ? "support" : "ref",
      rationale: `selection-${index + 1}`,
      ...(index === 1
        ? {
            slices: [
              {
                startLine: 10,
                endLine: 20,
                description: "slice",
                rationale: "seed",
              },
            ],
          }
        : {}),
    })),
    handoffSummary: {
      entrypoints: [{ path: "src/main.ts", notes: "entrypoint" }],
      keyModules: [{ path: "src/auth/login.ts", notes: "module" }],
      dataFlows: [{ name: "src/main.ts -> src/auth/login.ts", notes: "flow" }],
      configKnobs: [{ key: "AUTH_TIMEOUT", where: "src/config.ts", notes: "knob" }],
      tests: [{ path: "test/auth/login.test.ts", notes: "tests" }],
    },
  };
}

describe("evaluateLlmFallback", () => {
  test("applies deterministic retry schedule for rate limits", () => {
    expect(
      evaluateLlmFallback({
        kind: "rate_limit",
        retryCount: 0,
      }).retry,
    ).toEqual({
      shouldRetry: true,
      delayMs: 1000,
      maxRetries: 3,
    });
    expect(
      evaluateLlmFallback({
        kind: "rate_limit",
        retryCount: 1,
      }).retry,
    ).toEqual({
      shouldRetry: true,
      delayMs: 2000,
      maxRetries: 3,
    });
    expect(
      evaluateLlmFallback({
        kind: "rate_limit",
        retryCount: 2,
      }).retry,
    ).toEqual({
      shouldRetry: true,
      delayMs: 4000,
      maxRetries: 3,
    });
    expect(
      evaluateLlmFallback({
        kind: "rate_limit",
        retryCount: 3,
      }).retry,
    ).toEqual({
      shouldRetry: false,
      delayMs: 0,
      maxRetries: 3,
    });
  });

  test("retries one server error once then falls back", () => {
    const first = evaluateLlmFallback({ kind: "server_error", retryCount: 0 });
    expect(first.retry).toEqual({
      shouldRetry: true,
      delayMs: 1000,
      maxRetries: 1,
    });

    const second = evaluateLlmFallback({ kind: "server_error", retryCount: 1 });
    expect(second.retry.shouldRetry).toBe(false);
    expect(second.strategy).toBe("offline");
  });

  test("invalid/missing ctx_final retries when turns remain", () => {
    const invalidRetry = evaluateLlmFallback({
      kind: "invalid_ctx_final",
      turnsRemaining: 2,
    });
    expect(invalidRetry.retry.shouldRetry).toBe(true);
    expect(invalidRetry.strategy).toBe("hybrid");

    const missingRetry = evaluateLlmFallback({
      kind: "missing_ctx_final",
      turnsRemaining: 1,
    });
    expect(missingRetry.retry.shouldRetry).toBe(true);
    expect(missingRetry.strategy).toBe("hybrid");

    const invalidNoTurns = evaluateLlmFallback({
      kind: "invalid_ctx_final",
      turnsRemaining: 0,
    });
    expect(invalidNoTurns.retry.shouldRetry).toBe(false);
    expect(invalidNoTurns.strategy).toBe("hybrid");
  });
});

describe("mergePartialAndOfflineDiscovery", () => {
  test("keeps partial selection as seeds and fills from offline deterministically", () => {
    const partial = createDiscoveryResult(["src/seed.ts", "src/auth/login.ts"]);
    const offline = createDiscoveryResult([
      "src/auth/login.ts",
      "src/main.ts",
      "src/extra.ts",
    ]);

    const first = mergePartialAndOfflineDiscovery({
      partial,
      offline,
      maxSelectionEntries: 3,
    });
    const second = mergePartialAndOfflineDiscovery({
      partial,
      offline,
      maxSelectionEntries: 3,
    });

    expect(second).toEqual(first);
    expect(first.selection.map((entry) => entry.path)).toEqual([
      "src/seed.ts",
      "src/auth/login.ts",
      "src/main.ts",
    ]);
    expect(first.handoffSummary.entrypoints[0]?.path).toBe("src/main.ts");
  });
});

describe("resolveFallbackDiscovery", () => {
  test("returns retry-only result when policy says retry", () => {
    const result = resolveFallbackDiscovery({
      failure: { kind: "rate_limit", retryCount: 0 },
      offline: createDiscoveryResult(["src/offline.ts"]),
      partial: createDiscoveryResult(["src/partial.ts"]),
    });

    expect(result.decision.retry.shouldRetry).toBe(true);
    expect(result.discovery).toBeUndefined();
  });

  test("returns hybrid merged discovery for timeout failures", () => {
    const result = resolveFallbackDiscovery({
      failure: { kind: "agent_timeout" },
      partial: createDiscoveryResult(["src/partial.ts", "src/common.ts"]),
      offline: createDiscoveryResult(["src/common.ts", "src/offline.ts"]),
      maxSelectionEntries: 3,
    });

    expect(result.decision.strategy).toBe("hybrid");
    expect(result.discovery?.selection.map((entry) => entry.path)).toEqual([
      "src/partial.ts",
      "src/common.ts",
      "src/offline.ts",
    ]);
  });

  test("builds hybrid fallback from select_get payload when partial discovery is unavailable", () => {
    const result = resolveFallbackDiscovery({
      failure: { kind: "missing_ctx_final", turnsRemaining: 0 },
      partial: undefined,
      selectGetPayload: {
        view: "files",
        files: [
          {
            path: "src/recovered.ts",
            mode: "full",
            priority: "core",
            rationale: "select_get recovered",
          },
        ],
      },
      offline: createDiscoveryResult(["src/offline.ts", "src/recovered.ts"]),
      maxSelectionEntries: 3,
    });

    expect(result.decision.strategy).toBe("hybrid");
    expect(result.warning).toContain("LLM fallback");
    expect(result.discovery?.selection.map((entry) => entry.path)).toEqual([
      "src/recovered.ts",
      "src/offline.ts",
    ]);
  });

  test("falls back to pure offline result when no partial selection exists", () => {
    const offline = createDiscoveryResult(["src/offline.ts"]);
    const result = resolveFallbackDiscovery({
      failure: { kind: "network_error" },
      partial: undefined,
      offline,
    });

    expect(result.decision.strategy).toBe("offline");
    expect(result.discovery).toEqual(offline);
  });
});
