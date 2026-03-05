import { describe, expect, test } from "bun:test";
import { parseEnvOverrides } from "../../src/config/env";

describe("environment overrides", () => {
  test("maps supported CTX_* env vars to partial config overrides", () => {
    const result = parseEnvOverrides({
      env: {
        CTX_REPO: "/tmp/repo",
        CTX_BUDGET: "42000",
        CTX_MODE: "review",
        CTX_FORMAT: "xml",
        CTX_DISCOVER: "llm",
        CTX_PROVIDER: "anthropic",
        CTX_MODEL: "claude-3.7-sonnet",
        OPENAI_API_KEY: "openai-key",
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual({
      repo: { root: "/tmp/repo" },
      defaults: {
        budgetTokens: 42000,
        mode: "review",
        format: "xml",
      },
      discovery: {
        discover: "llm",
        provider: "anthropic",
        model: "claude-3.7-sonnet",
      },
    });
    expect(result.providerKeys).toEqual({
      openaiApiKey: "openai-key",
      anthropicApiKey: "anthropic-key",
    });
  });

  test("warns and skips invalid env values", () => {
    const result = parseEnvOverrides({
      env: {
        CTX_BUDGET: "0",
        CTX_MODE: "invalid",
        CTX_FORMAT: "json",
        CTX_DISCOVER: "internet",
        CTX_PROVIDER: "azure",
      },
    });

    expect(result.config).toEqual({});
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings.map((warning) => warning.keyPath)).toEqual([
      "env.CTX_BUDGET",
      "env.CTX_MODE",
      "env.CTX_FORMAT",
      "env.CTX_DISCOVER",
      "env.CTX_PROVIDER",
    ]);
  });

  test("ignores blank env var values", () => {
    const result = parseEnvOverrides({
      env: {
        CTX_REPO: "   ",
        OPENAI_API_KEY: "   ",
      },
    });

    expect(result.config).toEqual({});
    expect(result.providerKeys).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  test("emits warnings through callback", () => {
    const callbackWarnings: string[] = [];
    parseEnvOverrides({
      env: {
        CTX_BUDGET: "not-a-number",
      },
      onWarning: (warning) => callbackWarnings.push(warning.keyPath ?? ""),
    });

    expect(callbackWarnings).toEqual(["env.CTX_BUDGET"]);
  });
});
