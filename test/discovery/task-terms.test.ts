import { describe, expect, test } from "bun:test";
import { extractTaskTerms } from "../../src/discovery/task-terms";

describe("extractTaskTerms", () => {
  test("extracts identifiers, paths, config keys, endpoints, and normalized terms", () => {
    const task =
      "Add GitHubOAuth login to auth_flow in src/auth/login.ts, set AUTH_MODE and config.auth.mode for /api/v1/login.";

    const result = extractTaskTerms(task);

    expect(result.identifiers).toContain("GitHubOAuth");
    expect(result.identifiers).toContain("auth_flow");
    expect(result.paths).toEqual(["src/auth/login.ts"]);
    expect(result.configKeys).toEqual(["AUTH_MODE", "config.auth.mode"]);
    expect(result.endpoints).toEqual(["/api/v1/login"]);
    expect(result.searchTerms).toEqual([
      "add",
      "git",
      "hub",
      "oauth",
      "login",
      "auth",
      "flow",
      "src",
      "ts",
      "set",
      "mode",
      "config",
      "api",
      "v1",
    ]);
  });

  test("deduplicates while preserving deterministic order", () => {
    const task =
      "Refactor src/auth/login.ts and src/auth/login.ts to improve LoginFlow LoginFlow.";
    const result = extractTaskTerms(task);

    expect(result.paths).toEqual(["src/auth/login.ts"]);
    expect(result.identifiers).toEqual(["LoginFlow"]);
    expect(result.searchTerms).toEqual([
      "refactor",
      "src",
      "auth",
      "login",
      "ts",
      "improve",
      "flow",
    ]);
  });

  test("filters short and stop-word-only inputs", () => {
    const task = "a an the to in by on";
    const result = extractTaskTerms(task);

    expect(result.identifiers).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.configKeys).toEqual([]);
    expect(result.endpoints).toEqual([]);
    expect(result.searchTerms).toEqual([]);
  });
});
