import { describe, expect, test } from "bun:test";
import { mergeConfigPrecedence } from "../../src/config/merge";
import { createDefaultCtxConfig } from "../../src/config/schema";

describe("config precedence merge", () => {
  test("returns defaults when no overrides are provided", () => {
    const defaults = createDefaultCtxConfig();
    const merged = mergeConfigPrecedence({ defaults });
    expect(merged).toEqual(defaults);
  });

  test("applies precedence order: CLI > env > repo > user > defaults", () => {
    const merged = mergeConfigPrecedence({
      userConfig: {
        defaults: { budgetTokens: 42_000, mode: "question" },
        git: { diff: "main" },
      },
      repoConfig: {
        defaults: { budgetTokens: 50_000 },
        git: { diff: "uncommitted", maxFiles: 99 },
      },
      envConfig: {
        defaults: { budgetTokens: 55_000 },
        git: { diff: "unstaged" },
      },
      cliOverrides: {
        defaults: { budgetTokens: 60_000, mode: "review" },
        git: { diff: "staged" },
      },
    });

    expect(merged.defaults.budgetTokens).toBe(60_000);
    expect(merged.defaults.mode).toBe("review");
    expect(merged.git.diff).toBe("staged");
    expect(merged.git.maxFiles).toBe(99);
  });

  test("keeps default values for fields not overridden", () => {
    const merged = mergeConfigPrecedence({
      repoConfig: {
        discovery: { model: "gpt-5-mini" },
      },
    });

    expect(merged.discovery.model).toBe("gpt-5-mini");
    expect(merged.discovery.timeoutSeconds).toBe(600);
    expect(merged.output.runsDir).toBe(".ctx/runs");
  });

  test("copies array values from overrides", () => {
    const overrideIgnore = ["**/build/**"];
    const merged = mergeConfigPrecedence({
      repoConfig: {
        repo: { ignore: overrideIgnore },
      },
    });

    overrideIgnore.push("**/cache/**");
    expect(merged.repo.ignore).toEqual(["**/build/**"]);
  });

  test("forces offline discovery when privacy mode is airgap", () => {
    const merged = mergeConfigPrecedence({
      repoConfig: {
        privacy: { mode: "airgap" },
        discovery: { discover: "auto" },
      },
    });

    expect(merged.privacy.mode).toBe("airgap");
    expect(merged.discovery.discover).toBe("offline");
  });

  test("rejects explicit llm/local-cli discovery in airgap mode", () => {
    expect(() =>
      mergeConfigPrecedence({
        cliOverrides: {
          privacy: { mode: "airgap" },
          discovery: { discover: "llm" },
        },
      }),
    ).toThrow("privacy mode 'airgap' is incompatible");

    expect(() =>
      mergeConfigPrecedence({
        cliOverrides: {
          privacy: { mode: "airgap" },
          discovery: { discover: "local-cli" },
        },
      }),
    ).toThrow("privacy mode 'airgap' is incompatible");
  });
});
