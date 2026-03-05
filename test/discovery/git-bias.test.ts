import { describe, expect, test } from "bun:test";
import { computeGitDiscoveryBias } from "../../src/discovery/git-bias";

describe("computeGitDiscoveryBias", () => {
  test("boosts changed files and sets review-mode selection hints", () => {
    const bias = computeGitDiscoveryBias(
      [
        { path: "src/auth/login.ts", size: 1200 },
        { path: "src/auth/heavy.ts", size: 120000 },
      ],
      new Map(),
      {
        changedPaths: ["src/auth/login.ts", "src/auth/heavy.ts"],
        reviewMode: true,
        reviewLargeFileThresholdBytes: 50000,
      },
    );

    expect(bias.get("src/auth/login.ts")?.changedFileBoost).toBeGreaterThan(0);
    expect(bias.get("src/auth/login.ts")?.reviewModeSuggestedMode).toBe("full");
    expect(bias.get("src/auth/heavy.ts")?.reviewModeSuggestedMode).toBe("slices");
    expect(bias.get("src/auth/login.ts")?.reasons).toEqual(
      expect.arrayContaining(["changed_file", "review_mode_auto_select"]),
    );
  });

  test("boosts files importing changed files and matching tests", () => {
    const bias = computeGitDiscoveryBias(
      [
        { path: "src/auth/login.ts" },
        { path: "src/app.ts" },
        { path: "test/auth/login.test.ts" },
        { path: "tests/auth/login.spec.ts" },
        { path: "src/other.ts" },
      ],
      new Map<string, readonly string[]>([
        ["src/app.ts", ["src/auth/login.ts"]],
        ["src/other.ts", ["src/unknown.ts"]],
      ]),
      {
        changedPaths: ["src/auth/login.ts"],
      },
    );

    expect(bias.get("src/app.ts")?.importerBoost).toBeGreaterThan(0);
    expect(bias.get("src/app.ts")?.reasons).toContain("imports_changed_file");
    expect(bias.get("test/auth/login.test.ts")?.matchedTestBoost).toBeGreaterThan(0);
    expect(bias.get("tests/auth/login.spec.ts")?.matchedTestBoost).toBeGreaterThan(0);
    expect(bias.get("src/other.ts")).toBeUndefined();
  });

  test("returns deterministic outputs with normalized path keys", () => {
    const first = computeGitDiscoveryBias(
      [
        { path: "./src/main.ts" },
        { path: "src/app.ts" },
        { path: "test/main.test.ts" },
      ],
      new Map<string, readonly string[]>([["src/app.ts", ["src/main.ts"]]]),
      {
        changedPaths: ["./src/main.ts"],
      },
    );
    const second = computeGitDiscoveryBias(
      [
        { path: "src/app.ts" },
        { path: "test/main.test.ts" },
        { path: "src/main.ts" },
      ],
      new Map<string, readonly string[]>([["src/app.ts", ["src/main.ts"]]]),
      {
        changedPaths: ["src/main.ts"],
      },
    );

    expect([...first.keys()]).toEqual([...second.keys()]);
    expect(first.get("src/main.ts")?.totalBoost).toBe(
      second.get("src/main.ts")?.totalBoost,
    );
    expect(first.get("src/app.ts")?.totalBoost).toBe(
      second.get("src/app.ts")?.totalBoost,
    );
  });
});
