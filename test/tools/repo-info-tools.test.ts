import { describe, expect, test } from "bun:test";
import {
  executeRepoInfo,
  validateRepoInfoArgs,
} from "../../src/tools/repo-info-tools";

describe("repo_info tool arg validation", () => {
  test("accepts undefined and empty-object args", () => {
    expect(validateRepoInfoArgs(undefined)).toEqual({ ok: true });
    expect(validateRepoInfoArgs({})).toEqual({ ok: true });
  });

  test("rejects non-object and unexpected args", () => {
    expect(validateRepoInfoArgs("bad")).toEqual({
      ok: false,
      message: "args must be an object when provided",
    });
    expect(validateRepoInfoArgs({ unexpected: true })).toEqual({
      ok: false,
      message: "repo_info does not accept arguments",
    });
  });
});

describe("repo_info tool execution", () => {
  test("returns deterministic repo summary fields from scanned metadata", () => {
    const result = executeRepoInfo(undefined, {
      repoRoot: "/workspace/my-repo",
      repoFiles: [
        "package.json",
        "bun.lock",
        "Cargo.toml",
        "go.mod",
        "requirements.txt",
        "Makefile",
        "src/auth/login.ts",
        "src/auth/tokens.ts",
        "src/api/handler.ts",
        "README.md",
      ],
      scannedFiles: [
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
          lineCount: 60,
          symbols: [
            {
              kind: "function",
              signature: "export function handleRequest() {}",
              line: 8,
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
      indexStatus: "fresh",
      ignoreSummary: {
        gitignorePatterns: 11,
        configIgnores: 2,
      },
    });

    expect(result.repo_root).toBe("my-repo");
    expect(result.total_files).toBe(4);
    expect(result.index_status).toBe("fresh");
    expect(result.ignore_summary).toEqual({
      gitignore_patterns: 11,
      config_ignores: 2,
    });
    expect(result.build_hints).toEqual([
      "package.json (npm/bun)",
      "bun.lock (bun)",
      "Cargo.toml (rust)",
      "go.mod (go)",
      "requirements.txt (python)",
      "Makefile (make)",
    ]);

    expect(Object.keys(result.language_stats)).toEqual([
      "typescript",
      "markdown",
    ]);
    expect(result.language_stats.typescript).toBe(3);
    expect(result.language_stats.markdown).toBe(1);

    expect(result.module_map.modules.map((module) => module.module_path)).toEqual([
      "src/auth",
      ".",
      "src/api",
    ]);
    expect(result.module_map.modules[0]).toEqual({
      module_path: "src/auth",
      file_count: 2,
      total_lines: 200,
      primary_languages: [{ language: "typescript", file_count: 2 }],
      top_symbols: [
        {
          kind: "class",
          signature: "export class AuthService {}",
          path: "src/auth/login.ts",
          line: 2,
        },
        {
          kind: "type",
          signature: "export type AuthToken = string",
          path: "src/auth/tokens.ts",
          line: 1,
        },
      ],
    });
    expect(result.module_map.truncation).toEqual({
      max_modules: 30,
      max_symbols_per_module: 5,
      max_languages_per_module: 3,
      omitted_modules: 0,
    });
  });

  test("falls back to extension language detection and default summaries", () => {
    const result = executeRepoInfo(undefined, {
      repoRoot: "/workspace/fallback-repo",
      repoFiles: ["unknown.ext", "src/main.ts", "docs/readme.md"],
      indexStatus: "invalid-status",
      gitignorePatternCount: 3,
      configIgnorePatterns: ["dist/**", "*.tmp"],
    });

    expect(result.repo_root).toBe("fallback-repo");
    expect(result.total_files).toBe(3);
    expect(result.index_status).toBe("none");
    expect(result.ignore_summary).toEqual({
      gitignore_patterns: 3,
      config_ignores: 2,
    });
    expect(result.build_hints).toEqual([]);
    expect(result.language_stats).toEqual({
      markdown: 1,
      text: 1,
      typescript: 1,
    });
    expect(result.module_map.modules).toEqual([]);
  });
});
