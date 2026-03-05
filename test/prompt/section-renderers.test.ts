import { describe, expect, test } from "bun:test";

import {
  renderFilesSection,
  renderHandoffSummarySection,
  renderPromptSections,
  renderRepoOverviewSection,
  renderTokenReportSection,
  type RenderPromptSectionsInput,
} from "../../src/prompt";

describe("section renderers", () => {
  test("renders FILES with deterministic ordering, slice headers, and line numbers", () => {
    const rendered = renderFilesSection(
      [
        {
          path: "b.ts",
          mode: "full",
          priority: "core",
          rationale: "core path",
          content: "first\nsecond",
        },
        {
          path: "a.ts",
          mode: "slices",
          priority: "support",
          rationale: "slice path",
          slices: [
            {
              startLine: 10,
              endLine: 11,
              description: "slice block",
              rationale: "task hit",
              content: "alpha\nbeta",
            },
          ],
        },
        {
          path: "c.ts",
          mode: "codemap_only",
          priority: "ref",
          rationale: "codemap only",
        },
      ],
      { lineNumbers: true },
    );

    expect(rendered.split("\n")[0]).toBe("--- a.ts L10-L11 (slice block) ---");
    expect(rendered).toContain("0010| alpha");
    expect(rendered).toContain("0011| beta");
    expect(rendered).toContain("--- b.ts (full, priority=core) ---");
    expect(rendered).toContain("0001| first");
    expect(rendered).toContain("--- c.ts (codemap_only, priority=ref) ---");
  });

  test("renders TOKEN_REPORT with deterministic by-section and by-file ordering", () => {
    const rendered = renderTokenReportSection({
      budget: 60000,
      estimated: 42000,
      bySection: {
        files: 20000,
        metadata: 500,
        codemaps: 3000,
      },
      byFile: {
        "src/z.ts": 120,
        "src/a.ts": 500,
      },
      degradations: [
        {
          step: "full_to_slices",
          reason: "degrade src/a.ts full->slices",
          delta: 300,
        },
      ],
    });

    expect(rendered).toContain("budget: 60000");
    expect(rendered.indexOf("- codemaps: 3000")).toBeLessThan(
      rendered.indexOf("- files: 20000"),
    );
    expect(rendered.indexOf("- files: 20000")).toBeLessThan(
      rendered.indexOf("- metadata: 500"),
    );
    expect(rendered.indexOf("- src/a.ts: 500")).toBeLessThan(
      rendered.indexOf("- src/z.ts: 120"),
    );
  });

  test("renders handoff summary sections with path/data/config/test groupings", () => {
    const rendered = renderHandoffSummarySection({
      entrypoints: [{ path: "src/index.ts", notes: "CLI entry" }],
      keyModules: [{ path: "src/auth.ts", notes: "Auth flows" }],
      dataFlows: [{ name: "api->db", notes: "request path" }],
      configKnobs: [{ key: "CTX_BUDGET", where: ".ctx/config.toml", notes: "budget" }],
      tests: [{ path: "test/auth.test.ts", notes: "auth coverage" }],
    });

    expect(rendered).toContain("entrypoints:");
    expect(rendered).toContain("- src/index.ts: CLI entry");
    expect(rendered).toContain("data_flows:");
    expect(rendered).toContain("- api->db: request path");
    expect(rendered).toContain("config_knobs:");
    expect(rendered).toContain("- CTX_BUDGET @ .ctx/config.toml: budget");
  });

  test("renders repo overview with sorted language stats and deduped hints", () => {
    const rendered = renderRepoOverviewSection({
      buildHints: ["bun", "bun", "make"],
      languageStats: {
        TypeScript: 10,
        JSON: 3,
      },
      indexStatus: "fresh",
      gitStatusSummary: "2 changed files",
      ignoreSummary: {
        gitignorePatterns: 5,
        configIgnores: 2,
      },
      notes: ["cache enabled", "cache enabled", "repo-local index"],
    });

    expect(rendered).toContain("build_hints:");
    expect(rendered).toContain("- bun");
    expect(rendered).toContain("- make");
    expect(rendered.indexOf("- TypeScript: 10")).toBeLessThan(
      rendered.indexOf("- JSON: 3"),
    );
    expect(rendered).toContain("index_status: fresh");
    expect(rendered).toContain("ignore_summary: gitignore_patterns=5, config_ignores=2");
    expect(rendered).toContain("git_status:");
  });

  test("renders fixed section list from combined prompt input", () => {
    const input: RenderPromptSectionsInput = {
      metadata: [
        { key: "repo_root", value: "/repo" },
        { key: "run_id", value: "run-123" },
      ],
      task: "Explain selection behavior.",
      lineNumbers: true,
    };

    const sections = renderPromptSections(input);
    expect(sections.map((section) => section.key)).toEqual([
      "metadata",
      "task",
      "open_questions",
      "repo_overview",
      "tree",
      "handoff_summary",
      "codemaps",
      "files",
      "git_diff",
      "token_report",
      "manifest",
    ]);
    expect(sections[0]?.body).toContain("repo_root: /repo");
    expect(sections[1]?.body).toContain("Explain selection behavior.");
  });
});
