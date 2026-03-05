import { describe, expect, test } from "bun:test";
import { validateCtxFinalFromText } from "../../src/tools/ctx-final-validator";
import { formatCtxResultError } from "../../src/tools/result-formatter";
import { parseCtxToolBlocks } from "../../src/tools/tool-call-parser";

function parseCtxResultEnvelope(block: string): Record<string, unknown> {
  const match = block.match(/^```ctx_result\n([\s\S]+)\n```$/);
  if (!match || !match[1]) {
    throw new Error("invalid ctx_result block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function buildValidCtxFinalText(selectionPath = "src/index.ts"): string {
  return [
    "```ctx_final",
    JSON.stringify({
      open_questions: [
        {
          question: "Question?",
          why_it_matters: "Reason",
          default_assumption: "Default",
        },
      ],
      handoff_summary: {
        entrypoints: [{ path: selectionPath, notes: "entry" }],
        key_modules: [{ path: selectionPath, notes: "module" }],
        data_flows: [{ name: "flow", notes: "notes" }],
        config_knobs: [{ key: "mode", where: ".ctx/config.toml", notes: "knob" }],
        tests: [{ path: "test/tools/protocol-contract.test.ts", notes: "coverage" }],
      },
      selection: [
        {
          path: selectionPath,
          mode: "full",
          priority: "core",
          rationale: "entry",
        },
      ],
      extra_top_level_field: true,
    }),
    "```",
  ].join("\n");
}

describe("tool protocol contract", () => {
  test("parses ctx_tool blocks from mixed text in source order", () => {
    const text = [
      "intro text that should be ignored",
      "```ctx_tool",
      '{"id":"t1","tool":"file_search","args":{"pattern":"auth"}}',
      "```",
      "plain text between calls",
      "```ctx_tool",
      '{"id":"t2","tool":"read_file","args":{"path":"src/index.ts"}}',
      "```",
      "trailing text",
    ].join("\n");

    const parsed = parseCtxToolBlocks(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.calls).toEqual([
      { id: "t1", tool: "file_search", args: { pattern: "auth" } },
      { id: "t2", tool: "read_file", args: { path: "src/index.ts" } },
    ]);
  });

  test("continues parsing after malformed and invalid ctx_tool blocks", () => {
    const text = [
      "```ctx_tool",
      '{"id":"bad-json","tool":"file_search",',
      "```",
      "```ctx_tool",
      '{"tool":"file_search","args":{"pattern":"x"}}',
      "```",
      "```ctx_tool",
      '{"id":"bad-args","tool":"read_file","args":["not-an-object"]}',
      "```",
      "```ctx_tool",
      '{"id":"ok","tool":"read_file","args":{"path":"src/a.ts"}}',
      "```",
    ].join("\n");

    const parsed = parseCtxToolBlocks(text);
    expect(parsed.calls).toEqual([
      { id: "ok", tool: "read_file", args: { path: "src/a.ts" } },
    ]);
    expect(parsed.errors.map((error) => error.code)).toEqual([
      "INVALID_JSON",
      "INVALID_SHAPE",
      "INVALID_ARGS",
    ]);
  });

  test("handles realistic transcript with tool/result chatter and corrected ctx_final", () => {
    const transcript = [
      "assistant: scanning for auth entrypoints",
      "```ctx_tool",
      '{"id":"bad","tool":"select_get","args":{"view":"files"}',
      "```",
      "```ctx_result",
      '{"id":"bad","ok":false,"error":{"code":"INVALID_JSON","message":"unexpected end of JSON input"}}',
      "```",
      "assistant: corrected request",
      "```ctx_tool",
      '{"id":"good","tool":"select_get","args":{"view":"files","path_glob":"src/**"}}',
      "```",
      "assistant: provisional final (invalid JSON)",
      "```ctx_final",
      '{"open_questions":[]',
      "```",
      "assistant: corrected final follows",
      buildValidCtxFinalText("src/index.ts"),
    ].join("\n");

    const parsedTools = parseCtxToolBlocks(transcript);
    expect(parsedTools.calls).toEqual([
      { id: "good", tool: "select_get", args: { view: "files", path_glob: "src/**" } },
    ]);
    expect(parsedTools.errors).toHaveLength(1);
    expect(parsedTools.errors[0]?.code).toBe("INVALID_JSON");

    const validated = validateCtxFinalFromText(transcript, {
      availablePaths: ["src/index.ts", "test/tools/protocol-contract.test.ts"],
      turnsRemaining: 2,
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.discovery.selection[0]?.path).toBe("src/index.ts");
    }
  });

  test("formats INVALID_TOOL and INVALID_ARGS errors as ctx_result envelopes", () => {
    const invalidTool = parseCtxResultEnvelope(
      formatCtxResultError({
        id: "e1",
        error: {
          code: "INVALID_TOOL",
          message: "unknown tool: nope_tool",
        },
      }),
    );
    const invalidToolError = invalidTool.error as Record<string, unknown>;
    expect(invalidToolError.code).toBe("INVALID_TOOL");
    expect(invalidToolError.message).toContain("unknown tool");

    const invalidArgs = parseCtxResultEnvelope(
      formatCtxResultError({
        id: "e2",
        error: {
          code: "INVALID_ARGS",
          message: "args.path must be a string",
        },
      }),
    );
    const invalidArgsError = invalidArgs.error as Record<string, unknown>;
    expect(invalidArgsError.code).toBe("INVALID_ARGS");
    expect(invalidArgsError.message).toContain("args.path");
  });

  test("accepts extra ctx_final fields and validates required schema/paths", () => {
    const valid = validateCtxFinalFromText(buildValidCtxFinalText(), {
      availablePaths: ["src/index.ts", "test/tools/protocol-contract.test.ts"],
      turnsRemaining: 2,
    });
    expect(valid.ok).toBe(true);

    const missingRequired = validateCtxFinalFromText(
      [
        "```ctx_final",
        JSON.stringify({ selection: [] }),
        "```",
      ].join("\n"),
      {
        availablePaths: [],
        turnsRemaining: 2,
      },
    );
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.action).toBe("retry");
      expect(missingRequired.issues.some((issue) => issue.field === "open_questions")).toBe(
        true,
      );
    }

    const invalidPath = validateCtxFinalFromText(
      buildValidCtxFinalText("src/missing.ts"),
      {
        availablePaths: ["src/index.ts", "test/tools/protocol-contract.test.ts"],
        turnsRemaining: 1,
      },
    );
    expect(invalidPath.ok).toBe(false);
    if (!invalidPath.ok) {
      expect(
        invalidPath.issues.some((issue) =>
          issue.message.includes("path does not exist in repo"),
        ),
      ).toBe(true);
    }
  });
});
