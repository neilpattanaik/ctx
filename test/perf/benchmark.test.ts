import { describe, expect, test } from "bun:test";
import {
  evaluateBenchmarkTargets,
  parseBenchmarkSizes,
  resolveThresholdsForSize,
  type SizeBenchmarkResult,
} from "../../src/perf/benchmark";

describe("performance benchmark helpers", () => {
  test("parseBenchmarkSizes returns defaults when omitted", () => {
    expect(parseBenchmarkSizes(undefined)).toEqual([100, 500, 2000, 10000]);
  });

  test("parseBenchmarkSizes sorts and deduplicates", () => {
    expect(parseBenchmarkSizes("500, 100, 500, 2000")).toEqual([100, 500, 2000]);
  });

  test("parseBenchmarkSizes rejects non-positive values", () => {
    expect(() => parseBenchmarkSizes("0,100")).toThrow();
    expect(() => parseBenchmarkSizes("abc")).toThrow();
  });

  test("resolveThresholdsForSize uses small and large target buckets", () => {
    expect(resolveThresholdsForSize(100)).toEqual({
      coldToDiscoveryMs: 8000,
      warmToDiscoveryMs: 3000,
      discoveryMs: 2000,
      assemblyMs: 1000,
    });
    expect(resolveThresholdsForSize(2000)).toEqual({
      coldToDiscoveryMs: 30000,
      warmToDiscoveryMs: 10000,
      discoveryMs: 2000,
      assemblyMs: 1000,
    });
  });

  test("evaluateBenchmarkTargets reports pass/fail per scenario", () => {
    const passingResult: SizeBenchmarkResult = {
      size: 500,
      cold: {
        scanMs: 1000,
        indexMs: 2000,
        discoveryMs: 1500,
        budgetMs: 10,
        assemblyMs: 500,
        toDiscoveryMs: 4500,
        totalMs: 5200,
        filesScanned: 500,
        filesSelected: 50,
        estimatedTokens: 10000,
        promptTokens: 12000,
      },
      warm: {
        scanMs: 900,
        indexMs: 500,
        discoveryMs: 1200,
        budgetMs: 10,
        assemblyMs: 400,
        toDiscoveryMs: 2600,
        totalMs: 3300,
        filesScanned: 500,
        filesSelected: 50,
        estimatedTokens: 10000,
        promptTokens: 12000,
      },
    };
    const passingEvaluation = evaluateBenchmarkTargets(passingResult);
    expect(passingEvaluation.pass).toBeTrue();
    expect(passingEvaluation.cold.failures).toEqual([]);
    expect(passingEvaluation.warm.failures).toEqual([]);

    const failingResult: SizeBenchmarkResult = {
      ...passingResult,
      size: 2000,
      warm: {
        ...passingResult.warm,
        discoveryMs: 3000,
        assemblyMs: 1300,
        toDiscoveryMs: 13000,
      },
    };
    const failingEvaluation = evaluateBenchmarkTargets(failingResult);
    expect(failingEvaluation.pass).toBeFalse();
    expect(failingEvaluation.warm.failures).toContain(
      "warm to_discovery 13000ms > 10000ms",
    );
    expect(failingEvaluation.warm.failures).toContain(
      "warm discovery 3000ms > 2000ms",
    );
    expect(failingEvaluation.warm.failures).toContain(
      "warm assembly 1300ms > 1000ms",
    );
  });
});
