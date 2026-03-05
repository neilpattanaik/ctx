import { describe, expect, test } from "bun:test";

import {
  parseCtxFinalBlocks,
  validateCtxFinalFromText,
  validateCtxFinalPayload,
} from "../../src/tools";

function validPayload() {
  return {
    open_questions: [
      {
        question: "Is feature flag required?",
        why_it_matters: "Changes rollout behavior",
        default_assumption: "Flag remains enabled",
      },
    ],
    handoff_summary: {
      entrypoints: [{ path: "src/index.ts", notes: "CLI entry" }],
      key_modules: [{ path: "src/tools/index.ts", notes: "tool exports" }],
      data_flows: [{ name: "ctx_final", notes: "agent -> validator" }],
      config_knobs: [{ key: "mode", where: ".ctx/config.toml", notes: "run mode" }],
      tests: [{ path: "test/tools/ctx-final-validator.test.ts", notes: "contract coverage" }],
    },
    selection: [
      {
        path: "src/index.ts",
        mode: "full",
        priority: "core",
        rationale: "entrypoint",
      },
      {
        path: "src/tools/index.ts",
        mode: "slices",
        priority: "support",
        rationale: "tool surface",
        slices: [
          {
            start_line: 1,
            end_line: 12,
            description: "exports",
          },
        ],
      },
    ],
  };
}

describe("ctx_final validator", () => {
  test("accepts valid payload and maps snake_case fields into discovery result", () => {
    const result = validateCtxFinalPayload(validPayload(), {
      availablePaths: [
        "src/index.ts",
        "src/tools/index.ts",
        "test/tools/ctx-final-validator.test.ts",
      ],
      turnsRemaining: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discovery.openQuestions).toHaveLength(1);
      expect(result.discovery.handoffSummary.keyModules[0]?.path).toBe(
        "src/tools/index.ts",
      );
      expect(result.discovery.selection).toHaveLength(2);
      const slicesEntry = result.discovery.selection.find(
        (entry) => entry.mode === "slices",
      );
      expect(slicesEntry?.mode).toBe("slices");
    }
  });

  test("normalizes equivalent relative selection paths before existence checks", () => {
    const payload = validPayload();
    payload.selection[0].path = "./src\\index.ts";

    const result = validateCtxFinalPayload(payload, {
      availablePaths: ["src/index.ts", "src/tools/index.ts"],
      turnsRemaining: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discovery.selection[0]?.path).toBe("src/index.ts");
    }
  });

  test("ignores extra fields but fails on missing required fields", () => {
    const payload = {
      ...validPayload(),
      extra_top_level: true,
      handoff_summary: {
        ...validPayload().handoff_summary,
        extra_object_field: "ignored",
      },
    };

    const valid = validateCtxFinalPayload(payload, {
      availablePaths: ["src/index.ts", "src/tools/index.ts"],
      turnsRemaining: 1,
    });
    expect(valid.ok).toBe(true);

    const invalid = validateCtxFinalPayload(
      {
        ...payload,
        open_questions: [
          {
            question: "q",
            why_it_matters: "",
            default_assumption: "a",
          },
        ],
      },
      {
        availablePaths: ["src/index.ts", "src/tools/index.ts"],
        turnsRemaining: 1,
      },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.action).toBe("retry");
      expect(
        invalid.issues.some((issue) => issue.field.endsWith(".why_it_matters")),
      ).toBe(true);
    }
  });

  test("fails when selection path does not exist in repo file list", () => {
    const payload = validPayload();
    payload.selection[0].path = "src/does-not-exist.ts";

    const result = validateCtxFinalPayload(payload, {
      availablePaths: ["src/index.ts", "src/tools/index.ts"],
      turnsRemaining: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) =>
          issue.message.includes("path does not exist in repo"),
        ),
      ).toBe(true);
    }
  });

  test("parses ctx_final blocks and reports malformed JSON", () => {
    const text = [
      "prefix",
      "```ctx_final",
      "{not-json}",
      "```",
    ].join("\n");

    const parsed = parseCtxFinalBlocks(text);
    expect(parsed.payloads).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });

  test("accepts later valid ctx_final block when earlier block is malformed", () => {
    const valid = validPayload();
    valid.selection[0].path = "src/index.ts";

    const text = [
      "assistant reasoning",
      "```ctx_final",
      "{not-json}",
      "```",
      "assistant correction",
      "```ctx_final",
      JSON.stringify(valid),
      "```",
    ].join("\n");

    const result = validateCtxFinalFromText(text, {
      availablePaths: ["src/index.ts", "src/tools/index.ts"],
      turnsRemaining: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discovery.selection[0]?.path).toBe("src/index.ts");
    }
  });

  test("uses latest payload when multiple ctx_final blocks are present", () => {
    const first = validPayload();
    first.selection[0].path = "src/index.ts";
    const second = validPayload();
    second.selection[0].path = "src/tools/index.ts";

    const text = [
      "```ctx_final",
      JSON.stringify(first),
      "```",
      "```ctx_final",
      JSON.stringify(second),
      "```",
    ].join("\n");

    const result = validateCtxFinalFromText(text, {
      availablePaths: ["src/index.ts", "src/tools/index.ts"],
      turnsRemaining: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discovery.selection[0]?.path).toBe("src/tools/index.ts");
    }
  });

  test("returns detailed issues for adversarial malformed payload corpus", () => {
    const malformedPayloads = [
      {
        label: "selection mode typo",
        payload: {
          ...validPayload(),
          selection: [
            {
              path: "src/index.ts",
              mode: "slicez",
              priority: "core",
              rationale: "bad mode",
            },
          ],
        },
        expectedField: "selection[0].mode",
      },
      {
        label: "slice range inversion",
        payload: {
          ...validPayload(),
          selection: [
            {
              path: "src/tools/index.ts",
              mode: "slices",
              priority: "support",
              rationale: "bad range",
              slices: [
                {
                  start_line: 20,
                  end_line: 10,
                  description: "inverted",
                },
              ],
            },
          ],
        },
        expectedField: "selection[0].slices[0].end_line",
      },
      {
        label: "invalid open_questions shape",
        payload: {
          ...validPayload(),
          open_questions: [
            {
              question: "q",
              why_it_matters: "w",
              default_assumption: "",
            },
          ],
        },
        expectedField: "open_questions[0].default_assumption",
      },
    ] as const;

    for (const entry of malformedPayloads) {
      const result = validateCtxFinalPayload(entry.payload, {
        availablePaths: ["src/index.ts", "src/tools/index.ts"],
        turnsRemaining: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.action).toBe("retry");
        expect(result.issues.some((issue) => issue.field === entry.expectedField)).toBe(
          true,
        );
      }
    }
  });

  test("uses fallback action when validation fails with no turns remaining", () => {
    const invalidText = [
      "```ctx_final",
      JSON.stringify({ selection: [] }),
      "```",
    ].join("\n");

    const result = validateCtxFinalFromText(invalidText, {
      availablePaths: [],
      turnsRemaining: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.action).toBe("fallback");
    }
  });
});
