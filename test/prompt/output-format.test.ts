import { describe, expect, test } from "bun:test";

import { formatPromptOutput } from "../../src/prompt";

describe("formatPromptOutput", () => {
  test("renders markdown+xmltags with deterministic tag normalization", () => {
    const rendered = formatPromptOutput("markdown+xmltags", [
      { key: "TASK", body: "Investigate login flow." },
      { key: "Repo Overview", body: "TypeScript CLI." },
      { key: "Open Questions", body: "   " },
    ]);

    expect(rendered).toBe(
      [
        "<!-- CTX:BEGIN -->",
        "<task>",
        "Investigate login flow.",
        "</task>",
        "<repo_overview>",
        "TypeScript CLI.",
        "</repo_overview>",
        "<!-- CTX:END -->",
      ].join("\n"),
    );
  });

  test("renders markdown with section headers", () => {
    const rendered = formatPromptOutput("markdown", [
      { key: "task", body: "Trace cache invalidation behavior." },
      { key: "repo_overview", body: "Bun + TypeScript project." },
    ]);

    expect(rendered).toBe(
      [
        "## Task",
        "Trace cache invalidation behavior.",
        "",
        "## Repo Overview",
        "Bun + TypeScript project.",
      ].join("\n"),
    );
  });

  test("renders plain output with minimal labels", () => {
    const rendered = formatPromptOutput("plain", [
      { key: "task", body: "Explain auth middleware." },
      { key: "files", body: "src/auth/middleware.ts" },
    ]);

    expect(rendered).toBe(
      [
        "Task:",
        "Explain auth middleware.",
        "",
        "Files:",
        "src/auth/middleware.ts",
      ].join("\n"),
    );
  });

  test("renders xml output with CDATA-safe content", () => {
    const rendered = formatPromptOutput("xml", [
      { key: "task", body: "Token text includes ]]> boundary marker." },
    ]);

    expect(rendered).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<ctx_prompt>",
        "  <task><![CDATA[Token text includes ]]]]><![CDATA[> boundary marker.]]></task>",
        "</ctx_prompt>",
      ].join("\n"),
    );
  });

  test("keeps empty sections only when includeEmptySections is enabled", () => {
    const rendered = formatPromptOutput(
      "markdown+xmltags",
      [
        { key: "task", body: "Task body." },
        { key: "manifest", body: "" },
      ],
      { includeEmptySections: true },
    );

    expect(rendered).toContain("<manifest>");
    expect(rendered).toContain("</manifest>");
  });
});
