import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  isSubpath,
  matchGlob,
  normalizePath,
  pathDisplay,
  toAbsolute,
} from "../../src/utils/paths";

describe("path utilities", () => {
  const repoRoot = "/tmp/ctx-repo";

  test("normalizes absolute and relative paths to repo-relative posix paths", () => {
    expect(normalizePath("/tmp/ctx-repo/src/index.ts", repoRoot)).toBe(
      "src/index.ts",
    );
    expect(normalizePath("src\\utils\\paths.ts", repoRoot)).toBe(
      "src/utils/paths.ts",
    );
    expect(normalizePath(repoRoot, repoRoot)).toBe(".");
  });

  test("converts repo-relative paths to absolute paths", () => {
    expect(toAbsolute("src/utils/paths.ts", repoRoot)).toBe(
      resolve(repoRoot, "src/utils/paths.ts"),
    );
  });

  test("checks if candidate path is within parent", () => {
    expect(isSubpath("/tmp/ctx-repo/src/index.ts", "/tmp/ctx-repo")).toBe(true);
    expect(isSubpath("/tmp/other/file.ts", "/tmp/ctx-repo")).toBe(false);
  });

  test("formats path display in relative or absolute mode", () => {
    const input = "/tmp/ctx-repo/src/index.ts";

    expect(pathDisplay(input, "relative", repoRoot)).toBe("src/index.ts");
    expect(pathDisplay(input, "absolute", repoRoot)).toBe(
      "/tmp/ctx-repo/src/index.ts",
    );
  });

  test("matches globs with normalized separators", () => {
    expect(matchGlob("src/utils/paths.ts", "src/**/*.ts")).toBe(true);
    expect(matchGlob("src/utils/paths.ts", "src/*.ts")).toBe(false);
    expect(matchGlob("src\\utils\\paths.ts", "src/**/*.ts")).toBe(true);
  });
});
