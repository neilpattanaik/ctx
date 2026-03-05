import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGitignoreMatcher } from "../../src/scanner/gitignore";

describe("createGitignoreMatcher", () => {
  const repoRoot = resolve("test/fixtures/scanner/repo");
  const globalGitignorePath = resolve("test/fixtures/scanner/global.gitignore");

  test("applies root, nested, global, and config ignore rules", () => {
    const matcher = createGitignoreMatcher({
      repoRoot,
      useGitignore: true,
      extraIgnorePatterns: ["coverage/**"],
      resolveGlobalGitignorePath: () => globalGitignorePath,
    });

    expect(matcher.shouldIgnore("node_modules/lib/index.js", true)).toBe(true);
    expect(matcher.shouldIgnore("server.log")).toBe(true);
    expect(matcher.shouldIgnore("important.log")).toBe(false);

    expect(matcher.shouldIgnore("packages/app/secret.txt")).toBe(true);
    expect(matcher.shouldIgnore("packages/app/keep.secret.txt")).toBe(false);

    expect(matcher.shouldIgnore("tmp/cache.tmp")).toBe(true);
    expect(matcher.shouldIgnore("coverage/report.txt")).toBe(true);
  });

  test("skips gitignore loading when useGitignore is disabled but keeps config ignores", () => {
    const matcher = createGitignoreMatcher({
      repoRoot,
      useGitignore: false,
      extraIgnorePatterns: ["coverage/**"],
      resolveGlobalGitignorePath: () => globalGitignorePath,
    });

    expect(matcher.shouldIgnore("node_modules/lib/index.js", true)).toBe(false);
    expect(matcher.shouldIgnore("tmp/cache.tmp")).toBe(false);
    expect(matcher.shouldIgnore("coverage/report.txt")).toBe(true);
  });

  test("reports loaded layers in deterministic order", () => {
    const matcher = createGitignoreMatcher({
      repoRoot,
      useGitignore: true,
      extraIgnorePatterns: ["coverage/**"],
      resolveGlobalGitignorePath: () => globalGitignorePath,
    });

    expect(matcher.layers.map((layer) => layer.baseDir)).toEqual([
      "",
      "packages/app",
      "",
      "",
    ]);
    expect(matcher.layers[2]?.source).toBe(globalGitignorePath);
    expect(matcher.layers[3]?.source).toBe("<config.repo.ignore>");
  });

  test("resolves relative global excludesFile against the config file directory", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "ctx-gitignore-global-"));
    const globalConfigPath = join(tempHome, ".gitconfig");
    const globalIgnorePath = join(tempHome, "global-relative.ignore");
    writeFileSync(globalIgnorePath, "global.only\n", "utf8");
    writeFileSync(
      globalConfigPath,
      ["[core]", "\texcludesFile = global-relative.ignore", ""].join("\n"),
      "utf8",
    );

    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const previousHome = process.env.HOME;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.HOME = tempHome;

      const matcher = createGitignoreMatcher({
        repoRoot,
        useGitignore: true,
      });

      expect(matcher.shouldIgnore("global.only")).toBe(true);
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      }

      if (previousNoSystem === undefined) {
        delete process.env.GIT_CONFIG_NOSYSTEM;
      } else {
        process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
      }

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("loads and applies root plus nested .gitignore files from a real temp repo", () => {
    const tempRepo = mkdtempSync(join(tmpdir(), "ctx-gitignore-repo-"));
    const nestedDir = join(tempRepo, "packages", "app");
    const keepDir = join(nestedDir, "keep");
    const blockedDir = join(nestedDir, "blocked");
    writeFileSync(join(tempRepo, ".gitignore"), "*.log\n");
    writeFileSync(join(tempRepo, "server.log"), "log\n");
    writeFileSync(join(tempRepo, "keep.log"), "log\n");
    writeFileSync(join(tempRepo, "notes.txt"), "notes\n");
    mkdirSync(keepDir, { recursive: true });
    mkdirSync(blockedDir, { recursive: true });
    writeFileSync(join(nestedDir, ".gitignore"), "blocked/**\n!keep/**\n");
    writeFileSync(join(keepDir, "allow.ts"), "export const allow = true;\n");
    writeFileSync(join(blockedDir, "deny.ts"), "export const deny = true;\n");

    const matcher = createGitignoreMatcher({
      repoRoot: tempRepo,
      useGitignore: true,
      resolveGlobalGitignorePath: () => null,
    });

    expect(matcher.shouldIgnore("server.log")).toBe(true);
    expect(matcher.shouldIgnore("notes.txt")).toBe(false);
    expect(matcher.shouldIgnore("packages/app/blocked/deny.ts")).toBe(true);
    expect(matcher.shouldIgnore("packages/app/keep/allow.ts")).toBe(false);
  });
});
