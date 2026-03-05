import { describe, expect, test } from "bun:test";

import {
  getBuiltInTemplate,
  getBuiltInTemplateOrThrow,
  isPromptTemplateMode,
  listBuiltInTemplateModes,
  listBuiltInTemplates,
} from "../../src/prompt";

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
});
