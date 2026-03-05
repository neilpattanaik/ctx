import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import {
  searchContent,
  searchPaths,
} from "../../src/search/ripgrep";

function makeSpawnResult(overrides: Record<string, unknown>) {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

describe("searchContent", () => {
  test("parses rg JSON match and context lines", () => {
    const calls: string[][] = [];
    const stdout = [
      JSON.stringify({
        type: "context",
        data: {
          path: { text: "src/auth.ts" },
          line_number: 9,
          lines: { text: "before line\n" },
          submatches: [],
        },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/auth.ts" },
          line_number: 10,
          lines: { text: "const token = read();\n" },
          submatches: [{ match: { text: "token" }, start: 6, end: 11 }],
        },
      }),
      JSON.stringify({
        type: "context",
        data: {
          path: { text: "src/auth.ts" },
          line_number: 11,
          lines: { text: "after line\n" },
          submatches: [],
        },
      }),
    ].join("\n");

    const fakeSpawn = ((_, args) => {
      calls.push(args as string[]);
      return makeSpawnResult({
        status: 0,
        stdout,
      });
    }) as unknown as typeof spawnSync;

    const result = searchContent("token", {
      cwd: process.cwd(),
      contextLines: 1,
      maxCountPerFile: 5,
      maxFileSizeBytes: 2048,
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([
      {
        path: "src/auth.ts",
        line: 10,
        column: 7,
        excerpt: "const token = read();",
        submatches: ["token"],
        beforeContext: ["before line"],
        afterContext: ["after line"],
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--json",
      "--no-heading",
      "--line-number",
      "--color",
      "never",
      "--max-count",
      "5",
      "--max-filesize",
      "2048",
      "--context",
      "1",
      "--fixed-strings",
      "--",
      "token",
      ".",
    ]);
  });

  test("returns empty results when rg exits 1 with no matches", () => {
    const fakeSpawn = (() =>
      makeSpawnResult({
        status: 1,
        stdout: "",
      })) as unknown as typeof spawnSync;

    const result = searchContent("missing-pattern", {
      cwd: process.cwd(),
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
  });

  test("returns timeout error on ETIMEDOUT", () => {
    const fakeSpawn = (() =>
      makeSpawnResult({
        status: null,
        error: { code: "ETIMEDOUT" },
      })) as unknown as typeof spawnSync;

    const result = searchContent("slow-pattern", {
      cwd: process.cwd(),
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
  });

  test("returns unavailable when rgPath is invalid", () => {
    const result = searchContent("anything", {
      cwd: process.cwd(),
      rgPath: "/definitely/missing/rg",
    });

    expect(result.ok).toBe(false);
    expect(result.available).toBe(false);
    expect(result.error?.code).toBe("UNAVAILABLE");
  });
});

describe("searchPaths", () => {
  test("uses rg --files and filters deterministically", () => {
    const calls: string[][] = [];
    const fakeSpawn = ((_, args) => {
      calls.push(args as string[]);
      return makeSpawnResult({
        status: 0,
        stdout: [
          "README.md",
          "src/auth/login.ts",
          "src/auth/service.ts",
          "src/router.ts",
        ].join("\n"),
      });
    }) as unknown as typeof spawnSync;

    const result = searchPaths("auth", {
      cwd: process.cwd(),
      extensions: ["ts", ".md"],
      pathFilter: ["src/**"],
      exclude: ["dist/**"],
      maxResults: 10,
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([
      "src/auth/login.ts",
      "src/auth/service.ts",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--files",
      "--color",
      "never",
      "-g",
      "*.ts",
      "-g",
      "*.md",
      "-g",
      "src/**",
      "-g",
      "!dist/**",
    ]);
  });

  test("returns parse error for invalid regex patterns", () => {
    const fakeSpawn = (() =>
      makeSpawnResult({
        status: 0,
        stdout: "src/a.ts\n",
      })) as unknown as typeof spawnSync;

    const result = searchPaths("[", {
      cwd: process.cwd(),
      regex: true,
      spawnSyncImpl: fakeSpawn,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PARSE_ERROR");
  });
});
