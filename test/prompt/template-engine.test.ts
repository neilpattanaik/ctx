import { describe, expect, test } from "bun:test";
import { renderTemplate } from "../../src/prompt/template-engine";

describe("renderTemplate", () => {
  test("replaces known placeholders", () => {
    const template = [
      "<ctx_metadata>",
      "repo_root: {{REPO_ROOT}}",
      "run_id: {{RUN_ID}}",
      "</ctx_metadata>",
    ].join("\n");

    const result = renderTemplate(template, {
      REPO_ROOT: "/repo",
      RUN_ID: "run-123",
    });

    expect(result.output).toContain("repo_root: /repo");
    expect(result.output).toContain("run_id: run-123");
    expect(result.warnings).toEqual([]);
  });

  test("leaves unknown placeholders as-is and reports warnings", () => {
    const logs: string[] = [];
    const result = renderTemplate(
      "hello {{TASK}} {{UNKNOWN_SLOT}} {{UNKNOWN_SLOT}}",
      { TASK: "world" },
      { logger: (message) => logs.push(message) },
    );

    expect(result.output).toBe("hello world {{UNKNOWN_SLOT}} {{UNKNOWN_SLOT}}");
    expect(result.warnings).toEqual([
      "Unknown placeholder left unchanged: {{UNKNOWN_SLOT}}",
    ]);
    expect(logs).toEqual([
      "Unknown placeholder left unchanged: {{UNKNOWN_SLOT}}",
    ]);
  });

  test("omits empty placeholder sections by pruning empty xml-like tags", () => {
    const template = [
      "<task>{{TASK}}</task>",
      "<token_report>{{TOKEN_REPORT}}</token_report>",
      "<manifest>{{MANIFEST}}</manifest>",
    ].join("\n");

    const result = renderTemplate(template, {
      TASK: "Investigate failures",
      TOKEN_REPORT: "",
      MANIFEST: "",
    });

    expect(result.output).toBe("<task>Investigate failures</task>");
  });

  test("removes multiline empty sections deterministically", () => {
    const template = [
      "<token_report>",
      "{{TOKEN_REPORT}}",
      "</token_report>",
      "<files>{{FILES}}</files>",
    ].join("\n");

    const result = renderTemplate(template, {
      TOKEN_REPORT: "",
      FILES: "src/index.ts",
    });

    expect(result.output).toBe("<files>src/index.ts</files>");
  });
});
