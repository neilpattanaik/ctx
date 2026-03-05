import { describe, expect, test } from "bun:test";
import {
  buildSyntheticDiscoveryResult,
  buildSyntheticDiscoveryResultFromSelectGet,
  DiscoveryTurnManager,
  extractSelectionFromSelectGetPayload,
  LAST_TURN_CTX_FINAL_MESSAGE,
} from "../../src/discovery/turn-manager";
import type { SelectionEntry } from "../../src/types";

function createClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

describe("DiscoveryTurnManager", () => {
  test("issues one final-turn warning when max turns are exhausted", () => {
    const clock = createClock(1_000);
    const manager = new DiscoveryTurnManager({
      maxTurns: 2,
      timeoutMs: 600_000,
      now: clock.now,
    });

    const firstGate = manager.gateNextCall();
    expect(firstGate.allowCall).toBe(true);
    expect(firstGate.shouldRequestFinal).toBe(false);

    const turnOne = manager.startTurn();
    clock.advance(120);
    manager.finishTurn(turnOne);

    const turnTwo = manager.startTurn();
    clock.advance(80);
    manager.finishTurn(turnTwo);

    const warningGate = manager.gateNextCall();
    expect(warningGate.allowCall).toBe(true);
    expect(warningGate.shouldRequestFinal).toBe(true);
    expect(warningGate.reason).toBe("turn_limit");
    expect(warningGate.message).toBe(LAST_TURN_CTX_FINAL_MESSAGE);

    const finalTurn = manager.startTurn();
    clock.advance(40);
    manager.finishTurn(finalTurn);

    const stopGate = manager.gateNextCall();
    expect(stopGate.allowCall).toBe(false);
    expect(stopGate.shouldRequestFinal).toBe(false);
    expect(stopGate.reason).toBe("turn_limit");
  });

  test("issues final-turn warning when timeout is approaching", () => {
    const clock = createClock(0);
    const manager = new DiscoveryTurnManager({
      maxTurns: 10,
      timeoutMs: 120_000,
      perCallTimeoutMs: 60_000,
      now: clock.now,
    });

    clock.advance(65_000);
    const warningGate = manager.gateNextCall();
    expect(warningGate.allowCall).toBe(true);
    expect(warningGate.shouldRequestFinal).toBe(true);
    expect(warningGate.reason).toBe("timeout");
    expect(warningGate.message).toBe(LAST_TURN_CTX_FINAL_MESSAGE);

    const turn = manager.startTurn();
    clock.advance(5_000);
    manager.finishTurn(turn);

    const stopGate = manager.gateNextCall();
    expect(stopGate.allowCall).toBe(false);
    expect(stopGate.reason).toBe("timeout");
  });

  test("does not issue timeout warning immediately when per-call timeout is not provided", () => {
    const clock = createClock(0);
    const manager = new DiscoveryTurnManager({
      maxTurns: 4,
      timeoutMs: 60_000,
      now: clock.now,
    });

    const initialGate = manager.gateNextCall();
    expect(initialGate.allowCall).toBe(true);
    expect(initialGate.shouldRequestFinal).toBe(false);

    clock.advance(31_000);
    const warningGate = manager.gateNextCall();
    expect(warningGate.allowCall).toBe(true);
    expect(warningGate.shouldRequestFinal).toBe(true);
    expect(warningGate.reason).toBe("timeout");
  });

  test("tracks per-turn timing and aggregate stats", () => {
    const clock = createClock(10_000);
    const manager = new DiscoveryTurnManager({
      maxTurns: 4,
      timeoutMs: 120_000,
      now: clock.now,
    });

    const turnOne = manager.startTurn();
    clock.advance(30);
    manager.finishTurn(turnOne);

    const turnTwo = manager.startTurn();
    clock.advance(70);
    manager.finishTurn(turnTwo);

    const stats = manager.getStats();
    expect(stats.turnsCompleted).toBe(2);
    expect(stats.totalTurnTimeMs).toBe(100);
    expect(stats.turnTimings).toEqual([
      {
        turn: 1,
        startedAtMs: 10_000,
        finishedAtMs: 10_030,
        durationMs: 30,
      },
      {
        turn: 2,
        startedAtMs: 10_030,
        finishedAtMs: 10_100,
        durationMs: 70,
      },
    ]);
    expect(stats.timedOut).toBe(false);
  });
});

describe("buildSyntheticDiscoveryResult", () => {
  test("builds deterministic fallback discovery from partial selection", () => {
    const selection: SelectionEntry[] = [
      {
        path: "src/auth/login.ts",
        mode: "slices",
        priority: "support",
        rationale: "llm partial selection",
        slices: [
          {
            startLine: 10,
            endLine: 30,
            description: "auth flow",
            rationale: "match",
          },
        ],
      },
      {
        path: "src/main.ts",
        mode: "full",
        priority: "core",
        rationale: "llm partial selection",
      },
      {
        path: "test/auth/login.test.ts",
        mode: "codemap_only",
        priority: "ref",
        rationale: "llm partial selection",
      },
    ];

    const first = buildSyntheticDiscoveryResult({
      selection,
      reason: "missing_ctx_final",
    });
    const second = buildSyntheticDiscoveryResult({
      selection,
      reason: "missing_ctx_final",
    });

    expect(second).toEqual(first);
    expect(first.warning).toContain("agent did not emit ctx_final");
    expect(first.discovery.openQuestions).toEqual([]);
    expect(first.discovery.selection.map((entry) => entry.path)).toEqual([
      "src/main.ts",
      "src/auth/login.ts",
      "test/auth/login.test.ts",
    ]);
    expect(first.discovery.handoffSummary.entrypoints).toEqual([
      {
        path: "src/main.ts",
        notes: "derived from partial selection (full)",
      },
    ]);
    expect(first.discovery.handoffSummary.tests).toEqual([
      {
        path: "test/auth/login.test.ts",
        notes: "test file observed in partial selection",
      },
    ]);
    expect(first.discovery.handoffSummary.keyModules).toEqual([
      {
        path: "src/auth/login.ts",
        notes: "derived from partial selection (support)",
      },
      {
        path: "test/auth/login.test.ts",
        notes: "derived from partial selection (ref)",
      },
    ]);
  });
});

describe("extractSelectionFromSelectGetPayload", () => {
  test("extracts normalized selection entries from select_get files view", () => {
    const extracted = extractSelectionFromSelectGetPayload({
      view: "files",
      files: [
        {
          path: "./src/main.ts",
          mode: "full",
          priority: "core",
          rationale: "entrypoint",
        },
        {
          path: "src/auth/login.ts",
          mode: "slices",
          priority: "support",
          rationale: "targeted flow",
          slices: [
            {
              start_line: 10,
              end_line: 30,
              description: "handler",
            },
          ],
        },
        {
          path: "src/auth/login.ts",
          mode: "codemap_only",
          priority: "ref",
          rationale: "duplicate should be ignored",
        },
      ],
    });

    expect(extracted).toEqual([
      {
        path: "src/main.ts",
        mode: "full",
        priority: "core",
        rationale: "entrypoint",
      },
      {
        path: "src/auth/login.ts",
        mode: "slices",
        priority: "support",
        rationale: "targeted flow",
        slices: [
          {
            startLine: 10,
            endLine: 30,
            description: "handler",
            rationale: "targeted flow",
          },
        ],
      },
    ]);
  });

  test("degrades malformed slice entries to codemap_only during extraction", () => {
    const extracted = extractSelectionFromSelectGetPayload({
      view: "files",
      files: [
        {
          path: "src/feature.ts",
          mode: "slices",
          priority: "support",
          rationale: "missing ranges",
          slices: [{ start_line: 5, end_line: 1, description: "invalid" }],
        },
      ],
    });

    expect(extracted).toEqual([
      {
        path: "src/feature.ts",
        mode: "codemap_only",
        priority: "support",
        rationale: "missing ranges; slices unavailable during fallback",
      },
    ]);
  });
});

describe("buildSyntheticDiscoveryResultFromSelectGet", () => {
  test("constructs synthetic discovery result directly from select_get payload", () => {
    const result = buildSyntheticDiscoveryResultFromSelectGet({
      selectGetPayload: {
        view: "files",
        files: [
          {
            path: "src/server.ts",
            mode: "full",
            priority: "core",
            rationale: "entrypoint",
          },
          {
            path: "test/server.test.ts",
            mode: "codemap_only",
            priority: "ref",
            rationale: "test coverage",
          },
        ],
      },
      reason: "missing_ctx_final",
    });

    expect(result.extractedSelectionCount).toBe(2);
    expect(result.warning).toContain("agent did not emit ctx_final");
    expect(result.discovery.selection.map((entry) => entry.path)).toEqual([
      "src/server.ts",
      "test/server.test.ts",
    ]);
  });
});
