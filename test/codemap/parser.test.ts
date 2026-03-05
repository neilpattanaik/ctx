import { describe, expect, test } from "bun:test";

import {
  detectCodemapLanguage,
  TreeSitterCodemapParser,
} from "../../src/codemap";

describe("detectCodemapLanguage", () => {
  test("maps known source extensions to codemap languages", () => {
    expect(detectCodemapLanguage("src/main.ts")).toBe("typescript");
    expect(detectCodemapLanguage("src/app.jsx")).toBe("javascript");
    expect(detectCodemapLanguage("src/core.rs")).toBe("rust");
    expect(detectCodemapLanguage("src/App.swift")).toBe("swift");
    expect(detectCodemapLanguage("README.md")).toBeNull();
  });
});

describe("TreeSitterCodemapParser", () => {
  test("initializes parser runtime, lazily loads grammars, and caches language loads", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    expect(parser.getCachedLanguages()).toEqual([]);

    const first = await parser.parse(
      "export const value: number = 1;\n",
      "typescript",
    );
    expect(first.warnings).toEqual([]);
    expect(first.tree).not.toBeNull();
    expect(first.tree?.rootNode.type).toBe("program");
    expect(first.parseError).toBe(false);
    first.tree?.delete();

    expect(parser.getCachedLanguages()).toEqual(["typescript"]);

    const second = await parser.parse("const second = 2;\n", "typescript");
    expect(second.tree).not.toBeNull();
    second.tree?.delete();
    expect(parser.getCachedLanguages()).toEqual(["typescript"]);

    parser.dispose();
  });

  test("keeps partial parse trees and flags parse errors", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    const parsed = await parser.parse("function {", "javascript");
    expect(parsed.tree).not.toBeNull();
    expect(parsed.parseError).toBe(true);
    parsed.tree?.delete();

    parser.dispose();
  });

  test("returns deterministic warnings when grammar files are missing", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
      grammarPaths: {
        swift: "/definitely/missing/tree-sitter-swift.wasm",
      },
    });

    const parsed = await parser.parse("struct Feature {}", "swift");
    expect(parsed.tree).toBeNull();
    expect(parsed.parseError).toBe(false);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatchObject({
      language: "swift",
      code: "GRAMMAR_NOT_FOUND",
      grammarPath: "/definitely/missing/tree-sitter-swift.wasm",
    });

    expect(parser.getCachedLanguages()).toEqual(["swift"]);
    parser.dispose();
  });
});
