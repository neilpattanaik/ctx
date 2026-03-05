import { describe, expect, test } from "bun:test";
import {
  generateRunId,
  stableHash,
  stableSort,
  truncateStable,
} from "../../src/utils/deterministic";

describe("deterministic helpers", () => {
  test("stableSort preserves insertion order for equal comparisons", () => {
    const input = [
      { id: "a", score: 2 },
      { id: "b", score: 1 },
      { id: "c", score: 1 },
    ];

    const sorted = stableSort(input, (left, right) => left.score - right.score);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  test("stableHash uses deterministic sha-256 prefix", () => {
    expect(stableHash("hello")).toBe("2cf24dba5fb0");
  });

  test("generateRunId uses UTC timestamp and root hash", () => {
    const runId = generateRunId("/tmp/repo", new Date("2024-01-15T14:30:22Z"));
    expect(runId).toBe("20240115T143022-b6fe87a9");
  });

  test("truncateStable keeps deterministic ellipsis behavior", () => {
    expect(truncateStable("abcdefgh", 6)).toBe("abc...");
    expect(truncateStable("abcdefgh", 2, "...")).toBe("..");
  });
});
