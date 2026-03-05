import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runMainPipeline } from "../../src/cli/pipeline-runner";
import { createDefaultCtxConfig } from "../../src/config/schema";

function createFixtureRepoRoot(): string {
  const repoRoot = mkdtempSync(`${tmpdir()}/ctx-pipeline-runner-`);
  mkdirSync(resolve(repoRoot, "src", "auth"), { recursive: true });
  mkdirSync(resolve(repoRoot, "test", "auth"), { recursive: true });
  writeFileSync(
    resolve(repoRoot, "package.json"),
    JSON.stringify({ name: "ctx-pipeline-fixture", version: "1.0.0" }, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(repoRoot, "src", "auth", "login.ts"),
    [
      "export function login(username: string, password: string): boolean {",
      "  return username.length > 0 && password.length > 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(repoRoot, "test", "auth", "login.test.ts"),
    [
      "import { login } from '../../src/auth/login';",
      "describe('login', () => {",
      "  it('returns true for non-empty credentials', () => {",
      "    expect(login('u', 'p')).toBe(true);",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return repoRoot;
}

describe("runMainPipeline", () => {
  test("runs offline pipeline and persists run artifacts", async () => {
    const repoRoot = createFixtureRepoRoot();
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];

    const result = await runMainPipeline({
      repoRoot,
      task: "Investigate login flow and related tests",
      config,
      runId: "run-pipeline-test",
      now: () => new Date("2026-03-05T11:00:00.000Z"),
    });

    expect(result.discoveryBackend).toBe("offline");
    expect(result.filesScanned).toBeGreaterThanOrEqual(2);
    expect(result.filesSelected).toBeGreaterThanOrEqual(1);
    expect(result.prompt).toContain("Investigate login flow and related tests");
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.artifacts.persisted).toBeTrue();
    expect(result.artifacts.promptPath).toBeDefined();

    const runRecord = JSON.parse(readFileSync(result.artifacts.runRecordPath, "utf8")) as {
      runId: string;
      task: string;
      selection: Array<{ path: string }>;
    };
    expect(runRecord.runId).toBe("run-pipeline-test");
    expect(runRecord.task).toBe("Investigate login flow and related tests");
    expect(runRecord.selection.length).toBeGreaterThanOrEqual(1);
  });

  test("supports no-store-runs mode without writing artifacts", async () => {
    const repoRoot = createFixtureRepoRoot();
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];
    config.output.storeRuns = false;

    const result = await runMainPipeline({
      repoRoot,
      task: "Audit login task",
      config,
      runId: "run-no-store",
      now: () => new Date("2026-03-05T11:00:00.000Z"),
    });

    expect(result.artifacts.persisted).toBeFalse();
    expect(existsSync(result.artifacts.runRecordPath)).toBeFalse();
    expect(result.prompt).toContain("Audit login task");
  });

  test("respects no-index mode and falls back to first scanned file", async () => {
    const repoRoot = createFixtureRepoRoot();
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];
    config.index.enabled = false;
    config.output.storeRuns = false;

    const result = await runMainPipeline({
      repoRoot,
      task: "offline selection with no index",
      config,
      runId: "run-no-index",
      now: () => new Date("2026-03-05T11:00:00.000Z"),
    });

    expect(result.index.upsertedCount).toBe(0);
    expect(result.index.touchedCount).toBe(0);
    expect(result.index.deletedCount).toBe(0);
    expect(result.filesSelected).toBeGreaterThanOrEqual(1);
    expect(result.selection[0]?.path).toBe("package.json");
    expect(result.selection[0]?.rationale).toBe("fallback selection: first scanned file");
  });

  test("throws when failOnOverbudget is enabled and budget cannot be met", async () => {
    const repoRoot = createFixtureRepoRoot();
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];
    config.defaults.budgetTokens = 100;
    config.defaults.reserveTokens = 0;

    await expect(
      runMainPipeline({
        repoRoot,
        task: "force overbudget",
        config,
        runId: "run-overbudget",
        failOnOverbudget: true,
      }),
    ).rejects.toThrow("exceed budget");
  });

  test("throws when repository scan returns no readable files", async () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-pipeline-empty-`);
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];

    await expect(
      runMainPipeline({
        repoRoot,
        task: "empty repo task",
        config,
        runId: "run-empty",
      }),
    ).rejects.toThrow("No readable files found after repository scan");
  });

  test("applies custom privacy redaction patterns to final prompt output", async () => {
    const repoRoot = createFixtureRepoRoot();
    const config = createDefaultCtxConfig();
    config.repo.useGitignore = false;
    config.repo.ignore = [];
    config.output.storeRuns = false;
    config.privacy.redact = true;
    config.privacy.extraRedactPatterns = ["SECRET_[A-Z0-9]{8}"];

    const result = await runMainPipeline({
      repoRoot,
      task: "Investigate SECRET_ABC12345 usage",
      config,
      runId: "run-redaction",
      now: () => new Date("2026-03-05T11:00:00.000Z"),
    });

    expect(result.prompt).toContain("‹REDACTED:custom_pattern_1›");
    expect(result.prompt).not.toContain("SECRET_ABC12345");
  });
});
