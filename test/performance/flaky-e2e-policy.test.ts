import { describe, expect, test } from "bun:test";
import {
  buildFailureSignature,
  classifyCycleAttempts,
  findNewlyRecurringFlakeSignatures,
  findRecurringFlakeSignatures,
  mergeFlakyHistory,
  parseFailedTestNames,
} from "../integration/flaky-e2e";

describe("flaky e2e policy helpers", () => {
  test("parseFailedTestNames extracts unique failed test names from bun output", () => {
    const output = [
      "(fail) CLI end-to-end integration > captures root-cause diagnostics [120.00ms]",
      "(pass) CLI end-to-end integration > executes main flow [90.00ms]",
      "(fail) CLI end-to-end integration > captures root-cause diagnostics [130.00ms]",
      "(fail) scanner > handles unreadable nested dir [3.00ms]",
    ].join("\n");
    expect(parseFailedTestNames(output)).toEqual([
      "CLI end-to-end integration > captures root-cause diagnostics",
      "scanner > handles unreadable nested dir",
    ]);
  });

  test("buildFailureSignature returns PASS for zero-exit attempts", () => {
    expect(buildFailureSignature([], 0)).toBe("PASS");
  });

  test("classifyCycleAttempts returns pass when first attempt succeeds", () => {
    expect(
      classifyCycleAttempts([
        { exitCode: 0, failureSignature: "PASS" },
        { exitCode: 0, failureSignature: "PASS" },
      ]),
    ).toBe("pass");
  });

  test("classifyCycleAttempts returns flaky when rerun succeeds", () => {
    expect(
      classifyCycleAttempts([
        { exitCode: 1, failureSignature: "suite > test A" },
        { exitCode: 0, failureSignature: "PASS" },
      ]),
    ).toBe("flaky");
  });

  test("classifyCycleAttempts returns persistent_fail for repeated same signature", () => {
    expect(
      classifyCycleAttempts([
        { exitCode: 1, failureSignature: "suite > test A" },
        { exitCode: 1, failureSignature: "suite > test A" },
      ]),
    ).toBe("persistent_fail");
  });

  test("classifyCycleAttempts returns unstable_fail for shifting failure signatures", () => {
    expect(
      classifyCycleAttempts([
        { exitCode: 1, failureSignature: "suite > test A" },
        { exitCode: 1, failureSignature: "suite > test B" },
      ]),
    ).toBe("unstable_fail");
  });

  test("mergeFlakyHistory accumulates counts deterministically", () => {
    const merged = mergeFlakyHistory(
      {
        updatedAt: "2026-03-05T13:00:00.000Z",
        flakySignatureCounts: {
          "suite > test A": 1,
        },
      },
      {
        "suite > test B": 3,
        "suite > test A": 2,
      },
    );

    expect(merged.flakySignatureCounts).toEqual({
      "suite > test A": 3,
      "suite > test B": 3,
    });
  });

  test("findRecurringFlakeSignatures returns only signatures at or above threshold", () => {
    expect(
      findRecurringFlakeSignatures(
        {
          "suite > test A": 1,
          "suite > test B": 2,
          "suite > test C": 5,
        },
        2,
      ),
    ).toEqual(["suite > test B", "suite > test C"]);
  });

  test("findNewlyRecurringFlakeSignatures detects only threshold crossings", () => {
    expect(
      findNewlyRecurringFlakeSignatures(
        {
          "suite > test A": 1,
          "suite > test B": 3,
        },
        {
          "suite > test A": 2,
          "suite > test B": 4,
          "suite > test C": 1,
        },
        2,
      ),
    ).toEqual(["suite > test A"]);
  });
});
