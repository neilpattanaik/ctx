import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CTX_CONFIG,
  createDefaultCtxConfig,
} from "../../src/config/schema";

describe("config schema defaults", () => {
  test("defines a complete default config tree", () => {
    expect(DEFAULT_CTX_CONFIG.defaults.mode).toBe("plan");
    expect(DEFAULT_CTX_CONFIG.defaults.format).toBe("markdown+xmltags");
    expect(DEFAULT_CTX_CONFIG.defaults.budgetTokens).toBe(60_000);
    expect(DEFAULT_CTX_CONFIG.repo.useGitignore).toBe(true);
    expect(DEFAULT_CTX_CONFIG.index.engine).toBe("sqlite");
    expect(DEFAULT_CTX_CONFIG.discovery.discover).toBe("auto");
    expect(DEFAULT_CTX_CONFIG.localCli.agentPriority).toEqual([
      "codex-cli",
      "claude-cli",
      "gemini-cli",
    ]);
    expect(DEFAULT_CTX_CONFIG.git.maxPatchTokens).toBe(6000);
    expect(DEFAULT_CTX_CONFIG.privacy.mode).toBe("normal");
    expect(DEFAULT_CTX_CONFIG.output.runsDir).toBe(".ctx/runs");
  });

  test("creates defensive clones for nested arrays", () => {
    const clone = createDefaultCtxConfig();
    clone.repo.ignore.push("**/tmp/**");
    clone.localCli.agentPriority.push("custom-cli");
    clone.privacy.neverInclude.push("**/.secrets/**");

    expect(DEFAULT_CTX_CONFIG.repo.ignore).not.toContain("**/tmp/**");
    expect(DEFAULT_CTX_CONFIG.localCli.agentPriority).not.toContain(
      "custom-cli",
    );
    expect(DEFAULT_CTX_CONFIG.privacy.neverInclude).not.toContain(
      "**/.secrets/**",
    );
  });
});
