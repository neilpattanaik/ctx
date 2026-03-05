import { describe, expect, test } from "bun:test";
import { buildModuleMap } from "../../src/codemap";

describe("buildModuleMap", () => {
  test("groups files into compact modules with deterministic ordering and symbol caps", () => {
    const result = buildModuleMap(
      [
        {
          path: "src/auth/login.ts",
          language: "typescript",
          lineCount: 120,
          symbols: [
            {
              kind: "class",
              signature: "export class AuthService {}",
              line: 2,
            },
            {
              kind: "function",
              signature: "function internalHelper() {}",
              line: 50,
            },
          ],
        },
        {
          path: "src/auth/tokens.ts",
          language: "typescript",
          lineCount: 80,
          symbols: [
            {
              kind: "type",
              signature: "export type AuthToken = string",
              line: 1,
            },
          ],
        },
        {
          path: "src/api/handler.ts",
          language: "typescript",
          lineCount: 90,
          symbols: [
            {
              kind: "function",
              signature: "export function handleRequest() {}",
              line: 10,
            },
          ],
        },
        {
          path: "scripts/build.py",
          language: "python",
          lineCount: 40,
          symbols: [
            {
              kind: "function",
              signature: "def main():",
              line: 1,
            },
          ],
        },
        {
          path: "README.md",
          language: "markdown",
          lineCount: 12,
          symbols: [],
        },
      ],
      {
        maxSymbolsPerModule: 2,
      },
    );

    expect(result.modules.map((module) => module.modulePath)).toEqual([
      "src/auth",
      ".",
      "scripts",
      "src/api",
    ]);

    expect(result.modules[0]?.fileCount).toBe(2);
    expect(result.modules[0]?.totalLines).toBe(200);
    expect(result.modules[0]?.primaryLanguages).toEqual([
      { language: "typescript", fileCount: 2 },
    ]);

    const authSymbols = result.modules[0]?.topSymbols ?? [];
    expect(authSymbols).toHaveLength(2);
    expect(authSymbols[0]?.signature).toContain("export class AuthService");
    expect(authSymbols[1]?.signature).toContain("export type AuthToken");
  });

  test("caps modules and languages per module deterministically", () => {
    const result = buildModuleMap(
      [
        {
          path: "src/a/main.ts",
          language: "typescript",
          lineCount: 20,
          symbols: [],
        },
        {
          path: "src/a/helper.py",
          language: "python",
          lineCount: 10,
          symbols: [],
        },
        {
          path: "src/a/readme.md",
          language: "markdown",
          lineCount: 5,
          symbols: [],
        },
        {
          path: "src/b/main.ts",
          language: "typescript",
          lineCount: 12,
          symbols: [],
        },
        {
          path: "src/c/main.ts",
          language: "typescript",
          lineCount: 14,
          symbols: [],
        },
      ],
      {
        maxModules: 2,
        maxLanguagesPerModule: 2,
      },
    );

    expect(result.modules).toHaveLength(2);
    expect(result.truncation).toEqual({
      maxModules: 2,
      maxSymbolsPerModule: 5,
      maxLanguagesPerModule: 2,
      omittedModules: 1,
    });

    expect(result.modules[0]?.modulePath).toBe("src/a");
    expect(result.modules[0]?.primaryLanguages).toEqual([
      { language: "markdown", fileCount: 1 },
      { language: "python", fileCount: 1 },
    ]);
  });
});
