import { describe, expect, test } from "bun:test";
import { createDiscoveryAgentSystemPrompt } from "../../src/discovery/system-prompt";

describe("createDiscoveryAgentSystemPrompt", () => {
  test("includes role, constraints, protocol, and final output contract", () => {
    const prompt = createDiscoveryAgentSystemPrompt({
      task: "Investigate login failures",
      budgetTokens: 60000,
      reserveTokens: 15000,
      repoOverview: "TypeScript monorepo",
      initialSearchHints: ["auth", "login", "session"],
    });

    expect(prompt).toContain(
      "You are a codebase research agent. Your job is to explore this repository",
    );
    expect(prompt).toContain("MUST DO");
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("Use only ctx_tool blocks for tool calls");
    expect(prompt).toContain("End with a single ctx_final block containing:");
  });

  test("embeds task, budget, overview, and search hints deterministically", () => {
    const prompt = createDiscoveryAgentSystemPrompt({
      task: "Trace OAuth callback flow",
      budgetTokens: 1234,
      reserveTokens: 111,
      repoOverview: "repo summary",
      initialSearchHints: ["oauth", "callback"],
    });

    expect(prompt).toContain("Task:\nTrace OAuth callback flow");
    expect(prompt).toContain("Budget tokens: 1234");
    expect(prompt).toContain("Reserve tokens: 111");
    expect(prompt).toContain("Repo overview:\nrepo summary");
    expect(prompt).toContain("Initial search hints:\n- oauth\n- callback");
  });

  test("renders empty hints consistently", () => {
    const prompt = createDiscoveryAgentSystemPrompt({
      task: "Question",
      budgetTokens: 1,
      reserveTokens: 0,
      repoOverview: "overview",
      initialSearchHints: [],
    });

    expect(prompt).toContain("Initial search hints:\n- (none)");
  });
});
