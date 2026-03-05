import { describe, expect, test } from "bun:test";

import {
  getTemplateByName,
  getBuiltInTemplate,
  getBuiltInTemplateOrThrow,
  isPromptTemplateMode,
  listAvailableTemplates,
  listBuiltInTemplateModes,
  listBuiltInTemplates,
  loadCustomTemplates,
  parseTemplateFrontmatter,
  type TemplateLoaderIo,
} from "../../src/prompt";

function createTemplateIo(files: Record<string, string>): TemplateLoaderIo {
  return {
    readDir: (path: string) => {
      const prefix = `${path}/`;
      return Object.keys(files)
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length))
        .filter((fileName) => !fileName.includes("/"));
    },
    readFile: (path: string) => {
      const file = files[path];
      if (file === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return file;
    },
  };
}

describe("built-in prompt templates", () => {
  test("lists built-in template modes in deterministic order", () => {
    expect(listBuiltInTemplateModes()).toEqual([
      "plan",
      "question",
      "review",
      "context",
    ]);
  });

  test("returns expected template body for each mode", () => {
    const plan = getBuiltInTemplate("plan");
    const question = getBuiltInTemplate("question");
    const review = getBuiltInTemplate("review");
    const context = getBuiltInTemplate("context");

    expect(plan).toContain("<ctx_metadata>");
    expect(plan).toContain("mode: plan");
    expect(question).toContain("mode: question");
    expect(review).toContain("mode: review");
    expect(context).toContain("mode: context");
    expect(context).toContain("<manifest>");
  });

  test("throws on unknown built-in template mode", () => {
    expect(() => getBuiltInTemplateOrThrow("invalid-mode")).toThrow(
      "Unknown built-in template mode",
    );
  });

  test("validates mode strings and exposes template metadata", () => {
    expect(isPromptTemplateMode("plan")).toBe(true);
    expect(isPromptTemplateMode("invalid")).toBe(false);

    const templates = listBuiltInTemplates();
    expect(templates).toHaveLength(4);
    expect(templates[0]?.mode).toBe("plan");
    expect(templates[0]?.description).toContain("Architecture");
    expect(templates[3]?.mode).toBe("context");
  });

  test("parses optional frontmatter and returns body content", () => {
    const parsed = parseTemplateFrontmatter(
      [
        "---",
        "name: team_plan",
        "description: \"Team planning template\"",
        "---",
        "<task>{{TASK}}</task>",
      ].join("\n"),
    );

    expect(parsed.attributes).toEqual({
      name: "team_plan",
      description: "Team planning template",
    });
    expect(parsed.body).toBe("<task>{{TASK}}</task>");
  });

  test("loads custom templates from .ctx/templates and applies deterministic override", () => {
    const io = createTemplateIo({
      "/repo/.ctx/templates/a.md": [
        "---",
        "name: plan",
        "---",
        "custom plan A",
      ].join("\n"),
      "/repo/.ctx/templates/z.md": [
        "---",
        "name: plan",
        "description: \"custom plan override\"",
        "---",
        "custom plan Z",
      ].join("\n"),
      "/repo/.ctx/templates/ops.md": "ops body",
      "/repo/.ctx/templates/README.txt": "ignore",
    });

    const templates = loadCustomTemplates("/repo", io);
    expect(templates.map((template) => template.name)).toEqual(["ops", "plan"]);
    expect(templates.find((template) => template.name === "plan")?.body).toBe(
      "custom plan Z",
    );
    expect(
      templates.find((template) => template.name === "plan")?.description,
    ).toBe("custom plan override");
  });

  test("lists built-in and custom templates with custom overrides", () => {
    const io = createTemplateIo({
      "/repo/.ctx/templates/plan.md": [
        "---",
        "name: plan",
        "description: custom plan override",
        "---",
        "custom plan body",
      ].join("\n"),
      "/repo/.ctx/templates/team_review.md": "custom review body",
    });

    const templates = listAvailableTemplates("/repo", io);
    expect(templates.find((template) => template.name === "plan")?.source).toBe(
      "custom",
    );
    expect(templates.find((template) => template.name === "plan")?.body).toBe(
      "custom plan body",
    );
    expect(
      templates.find((template) => template.name === "team_review")?.source,
    ).toBe("custom");
    expect(templates.find((template) => template.name === "question")?.source).toBe(
      "built_in",
    );
  });

  test("resolves templates by name with normalization", () => {
    const io = createTemplateIo({
      "/repo/.ctx/templates/team_plan.md": "team plan body",
    });

    const match = getTemplateByName(" Team Plan ", "/repo", io);
    expect(match?.name).toBe("team_plan");
    expect(match?.body).toBe("team plan body");
    expect(getTemplateByName("missing", "/repo", io)).toBeNull();
  });
});
