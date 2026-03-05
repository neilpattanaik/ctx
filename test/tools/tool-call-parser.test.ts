import { describe, expect, test } from "bun:test";
import { parseCtxToolBlocks } from "../../src/tools/tool-call-parser";

describe("parseCtxToolBlocks", () => {
  test("extracts valid ctx_tool blocks in source order", () => {
    const text = [
      "intro text",
      "```ctx_tool",
      '{"id":"t1","tool":"file_search","args":{"pattern":"OAuth"}}',
      "```",
      "middle text",
      "```ctx_tool",
      '{"id":"t2","tool":"read_file","args":{"path":"src/index.ts"}}',
      "```",
    ].join("\n");

    const result = parseCtxToolBlocks(text);
    expect(result.errors).toEqual([]);
    expect(result.calls).toEqual([
      { id: "t1", tool: "file_search", args: { pattern: "OAuth" } },
      { id: "t2", tool: "read_file", args: { path: "src/index.ts" } },
    ]);
  });

  test("keeps parsing after invalid JSON blocks", () => {
    const text = [
      "```ctx_tool",
      '{"id":"bad","tool":"file_search",',
      "```",
      "```ctx_tool",
      '{"id":"ok","tool":"read_file","args":{"path":"a.ts"}}',
      "```",
    ].join("\n");

    const result = parseCtxToolBlocks(text);
    expect(result.calls).toEqual([
      { id: "ok", tool: "read_file", args: { path: "a.ts" } },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      index: 1,
      code: "INVALID_JSON",
    });
  });

  test("returns validation errors for missing fields and invalid args", () => {
    const text = [
      "```ctx_tool",
      '{"tool":"file_search"}',
      "```",
      "```ctx_tool",
      '{"id":"x","tool":"file_search","args":["not-an-object"]}',
      "```",
      "```ctx_tool",
      '{"id":"y","tool":"file_search"}',
      "```",
    ].join("\n");

    const result = parseCtxToolBlocks(text);

    expect(result.calls).toEqual([{ id: "y", tool: "file_search", args: {} }]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({
      index: 1,
      code: "INVALID_SHAPE",
    });
    expect(result.errors[1]).toMatchObject({
      index: 2,
      code: "INVALID_ARGS",
    });
  });

  test("parses protocol-style mixed transcript with ctx_result chatter and malformed blocks", () => {
    const text = [
      "assistant: investigating repository shape",
      "```ctx_tool",
      '{"id":"bad-json","tool":"file_search","args":{"pattern":"auth"}',
      "```",
      "```ctx_result",
      '{"id":"bad-json","ok":false,"error":{"code":"INVALID_JSON","message":"oops"}}',
      "```",
      "assistant: retrying with corrected call",
      "```ctx_tool",
      '{"id":"call-2","tool":"select_get","args":{"view":"files","path_glob":"src/**"}}',
      "```",
      "assistant: one more tool call",
      "```ctx_tool",
      '{"id":"call-3","tool":"read_file","args":{"path":"src/index.ts","start_line":1,"end_line":40}}',
      "```",
    ].join("\n");

    const result = parseCtxToolBlocks(text);
    expect(result.calls).toEqual([
      {
        id: "call-2",
        tool: "select_get",
        args: { view: "files", path_glob: "src/**" },
      },
      {
        id: "call-3",
        tool: "read_file",
        args: { path: "src/index.ts", start_line: 1, end_line: 40 },
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      index: 1,
      code: "INVALID_JSON",
    });
  });
});
