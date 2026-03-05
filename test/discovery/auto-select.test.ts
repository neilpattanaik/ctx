import { describe, expect, test } from "bun:test";
import { createDefaultCtxConfig } from "../../src/config/schema";
import { resolveDiscoveryBackend } from "../../src/discovery/auto-select";
import type { ProviderApiKeys } from "../../src/config/env";
import type { CtxConfig } from "../../src/types";

function withConfig(
  mutate: (config: CtxConfig) => void,
): Pick<CtxConfig, "discovery" | "localCli" | "privacy"> {
  const config = createDefaultCtxConfig();
  mutate(config);
  return {
    discovery: config.discovery,
    localCli: config.localCli,
    privacy: config.privacy,
  };
}

function providerKeys(overrides: Partial<ProviderApiKeys>): ProviderApiKeys {
  return {
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    googleApiKey: undefined,
    ...overrides,
  };
}

describe("resolveDiscoveryBackend", () => {
  test("forces offline in airgap privacy mode", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.privacy.mode = "airgap";
        config.discovery.discover = "auto";
      }),
      providerKeys: providerKeys({
        openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
    });

    expect(result.discover).toBe("offline");
    expect(result.reason).toContain("airgap");
  });

  test("forces offline when --no-llm is set", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.discovery.discover = "auto";
      }),
      noLlm: true,
      providerKeys: providerKeys({
        openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
    });

    expect(result.discover).toBe("offline");
    expect(result.reason).toContain("--no-llm");
  });

  test("auto-selects llm when provider key is valid and reachable", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.discovery.discover = "auto";
        config.discovery.provider = "openai";
        config.discovery.model = "gpt-4o";
      }),
      providerKeys: providerKeys({
        openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
      }),
      providerHealthCheck: (input) => {
        expect(input.provider).toBe("openai");
        expect(input.timeoutMs).toBe(2000);
        return true;
      },
    });

    expect(result.discover).toBe("llm");
    expect(result.provider).toBe("openai");
    expect(result.logMessage).toContain("openai API (gpt-4o)");
  });

  test("auto-falls back to local-cli when provider is unavailable", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.discovery.discover = "auto";
        config.discovery.provider = "openai";
        config.localCli.agentPriority = ["codex-cli", "claude-cli"];
        config.localCli.codexCliCommand = "codex";
        config.localCli.claudeCliCommand = "claude";
      }),
      providerKeys: providerKeys({}),
      localCliCommandCheck: (command) => command === "claude",
    });

    expect(result.discover).toBe("local-cli");
    expect(result.localCliAgent).toBe("claude-cli");
    expect(result.reason).toContain("provider unavailable");
  });

  test("auto-falls back to offline when provider/local-cli are unavailable", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.discovery.discover = "auto";
        config.discovery.provider = "openai";
        config.localCli.agentPriority = ["codex-cli"];
        config.localCli.codexCliCommand = "codex";
      }),
      providerKeys: providerKeys({
        openaiApiKey: "bad-key",
      }),
      localCliCommandCheck: () => false,
    });

    expect(result.discover).toBe("offline");
    expect(result.reason).toContain("provider unavailable");
  });

  test("forced llm mode degrades to local-cli/offline when provider is unavailable", () => {
    const config = withConfig((raw) => {
      raw.discovery.discover = "llm";
      raw.discovery.provider = "anthropic";
      raw.localCli.agentPriority = ["claude-cli"];
      raw.localCli.claudeCliCommand = "claude";
    });
    const withLocalCli = resolveDiscoveryBackend({
      config,
      providerKeys: providerKeys({
        anthropicApiKey: "sk-ant-invalid",
      }),
      localCliCommandCheck: (command) => command === "claude",
    });
    expect(withLocalCli.discover).toBe("local-cli");

    const offlineOnly = resolveDiscoveryBackend({
      config,
      providerKeys: providerKeys({
        anthropicApiKey: "sk-ant-invalid",
      }),
      localCliCommandCheck: () => false,
    });
    expect(offlineOnly.discover).toBe("offline");
  });

  test("forced local-cli mode falls back to offline when command is missing", () => {
    const result = resolveDiscoveryBackend({
      config: withConfig((config) => {
        config.discovery.discover = "local-cli";
        config.localCli.agentPriority = ["gemini-cli"];
        config.localCli.geminiCliCommand = "gemini";
      }),
      localCliCommandCheck: () => false,
    });

    expect(result.discover).toBe("offline");
    expect(result.reason).toContain("local-cli unavailable");
  });
});
