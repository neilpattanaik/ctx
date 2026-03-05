import { describe, expect, test } from "bun:test";

import {
  classifyAttemptExitCodes,
  computeRecurringFlakeCount,
  decideGateExitCode,
  normalizeFlakeOutput,
  parseFlakeGateArgs,
  type AttemptSnapshot,
  type FlakeHistoryEntry,
} from "./e2e-flake-gate";

function attempt(exitCode: number): AttemptSnapshot {
  return {
    attempt: 1,
    exit_code: exitCode,
    signal: null,
    duration_ms: 10,
    stdout_line_count: 1,
    stderr_line_count: 1,
    stdout_hash: "stdout",
    stderr_hash: "stderr",
    combined_hash: "combined",
  };
}

describe("parseFlakeGateArgs", () => {
  test("applies defaults and env-controlled auto-bead option", () => {
    const previous = process.env.CTX_E2E_FLAKE_AUTO_BEAD;
    process.env.CTX_E2E_FLAKE_AUTO_BEAD = "1";
    try {
      const parsed = parseFlakeGateArgs(["--command", "bun run test:e2e:ci:raw"]);
      expect(parsed.command).toBe("bun run test:e2e:ci:raw");
      expect(parsed.maxReruns).toBe(1);
      expect(parsed.autoOpenBead).toBe(true);
      expect(parsed.allowFlakyPass).toBe(false);
      expect(parsed.flakeThreshold).toBe(3);
      expect(parsed.windowDays).toBe(14);
    } finally {
      if (previous === undefined) {
        delete process.env.CTX_E2E_FLAKE_AUTO_BEAD;
      } else {
        process.env.CTX_E2E_FLAKE_AUTO_BEAD = previous;
      }
    }
  });

  test("supports explicit overrides", () => {
    const parsed = parseFlakeGateArgs([
      "--command=bun run test:e2e:ci:raw",
      "--max-reruns=2",
      "--report",
      "tmp/report.json",
      "--history",
      "tmp/history.json",
      "--flake-threshold",
      "5",
      "--window-days",
      "21",
      "--allow-flaky-pass",
      "--no-auto-open-bead",
      "--parent-bead",
      "ctx-abc",
      "--bead-priority",
      "2",
      "--json",
    ]);
    expect(parsed.maxReruns).toBe(2);
    expect(parsed.reportPath).toBe("tmp/report.json");
    expect(parsed.historyPath).toBe("tmp/history.json");
    expect(parsed.flakeThreshold).toBe(5);
    expect(parsed.windowDays).toBe(21);
    expect(parsed.allowFlakyPass).toBe(true);
    expect(parsed.autoOpenBead).toBe(false);
    expect(parsed.parentBead).toBe("ctx-abc");
    expect(parsed.beadPriority).toBe(2);
    expect(parsed.json).toBe(true);
  });

  test("rejects missing command", () => {
    expect(() => parseFlakeGateArgs(["--max-reruns", "1"])).toThrow(
      "--command is required",
    );
  });
});

describe("classifyAttemptExitCodes", () => {
  test("classifies stable pass", () => {
    expect(classifyAttemptExitCodes([0])).toBe("stable_pass");
    expect(classifyAttemptExitCodes([0, 1])).toBe("stable_pass");
  });

  test("classifies flaky recovered", () => {
    expect(classifyAttemptExitCodes([1, 0])).toBe("flaky_recovered");
    expect(classifyAttemptExitCodes([2, 3, 0])).toBe("flaky_recovered");
  });

  test("classifies hard fail", () => {
    expect(classifyAttemptExitCodes([1])).toBe("hard_fail");
    expect(classifyAttemptExitCodes([2, 3, 4])).toBe("hard_fail");
    expect(classifyAttemptExitCodes([])).toBe("hard_fail");
  });
});

describe("decideGateExitCode", () => {
  test("returns 0 for stable pass", () => {
    expect(decideGateExitCode("stable_pass", false, [attempt(0)])).toBe(0);
  });

  test("treats flaky recovered as failure by default", () => {
    const attempts = [attempt(1), attempt(0)];
    expect(decideGateExitCode("flaky_recovered", false, attempts)).toBe(1);
    expect(decideGateExitCode("flaky_recovered", true, attempts)).toBe(0);
  });

  test("returns final failure code for hard fail", () => {
    const attempts = [attempt(1), attempt(3)];
    expect(decideGateExitCode("hard_fail", false, attempts)).toBe(3);
  });
});

describe("computeRecurringFlakeCount", () => {
  test("counts only matching flaky_recovered entries within window", () => {
    const nowMs = Date.parse("2026-03-05T12:00:00.000Z");
    const entries: FlakeHistoryEntry[] = [
      {
        timestamp: "2026-03-04T11:00:00.000Z",
        classification: "flaky_recovered",
        command_hash: "abc",
        combined_hash: "h1",
        attempts: 2,
      },
      {
        timestamp: "2026-02-18T11:00:00.000Z",
        classification: "flaky_recovered",
        command_hash: "abc",
        combined_hash: "h2",
        attempts: 2,
      },
      {
        timestamp: "2026-03-04T11:00:00.000Z",
        classification: "hard_fail",
        command_hash: "abc",
        combined_hash: "h3",
        attempts: 2,
      },
      {
        timestamp: "2026-03-04T11:00:00.000Z",
        classification: "flaky_recovered",
        command_hash: "xyz",
        combined_hash: "h4",
        attempts: 2,
      },
    ];

    expect(computeRecurringFlakeCount(entries, "abc", 14, nowMs)).toBe(1);
    expect(computeRecurringFlakeCount(entries, "abc", 30, nowMs)).toBe(2);
  });
});

describe("normalizeFlakeOutput", () => {
  test("normalizes run ids, durations, and temp paths", () => {
    const raw = [
      'run_id: abc-123',
      '{"run_id":"20260305T130000-deadbeef","duration_ms":42}',
      '/tmp/ctx-e2e-soak-xyz/src/index.ts',
      'bundle: 20260305T130001-cafefeed',
    ].join("\n");

    const normalized = normalizeFlakeOutput(raw);
    expect(normalized).toContain("run_id: <run-id>");
    expect(normalized).toContain('"run_id":"<run-id>"');
    expect(normalized).toContain('"duration_ms":<duration_ms>');
    expect(normalized).toContain("<tmp-repo>/src/index.ts");
    expect(normalized).toContain("bundle: <run-id>");
  });
});
