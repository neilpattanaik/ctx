import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../../src/cli";
import { run } from "../../src/index";

describe("CLI argument parser", () => {
  test("parses main command flags across all groups", () => {
    const parsed = parseCliArgs([
      "investigate",
      "login",
      "--mode",
      "review",
      "--format",
      "xml",
      "--output",
      "prompt.xml",
      "--copy",
      "--quiet",
      "--verbose",
      "--json-summary",
      "--budget",
      "50000",
      "--reserve",
      "12000",
      "--max-files",
      "40",
      "--max-full-files",
      "8",
      "--max-slices-per-file",
      "3",
      "--max-file-bytes",
      "900000",
      "--fail-on-overbudget",
      "--discover",
      "offline",
      "--agent",
      "codex-cli",
      "--model",
      "gpt-5-codex",
      "--agent-timeout",
      "120",
      "--agent-max-turns",
      "10",
      "--dry-run",
      "--task-file",
      "task.md",
      "--repo",
      "/repo",
      "--cache",
      "repo",
      "--cache-dir",
      "/tmp/cache",
      "--no-index",
      "--tree",
      "selected",
      "--codemaps",
      "auto",
      "--line-numbers",
      "on",
      "--include",
      "src/**",
      "--exclude",
      "dist/**",
      "--prefer-full",
      "src/index.ts",
      "--prefer-slices",
      "src/**/*.ts",
      "--prefer-codemap",
      "src/types/**",
      "--entrypoint",
      "src/index.ts",
      "--diff",
      "uncommitted",
      "--git-status",
      "on",
      "--git-max-files",
      "25",
      "--git-max-patch-tokens",
      "5000",
      "--privacy",
      "strict",
      "--redact",
      "on",
      "--redact-pattern",
      "token_[A-Za-z0-9]+",
      "--never-include",
      "**/.env",
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.kind).toBe("main");
    if (parsed.value.kind !== "main") {
      return;
    }

    expect(parsed.value.taskText).toBe("investigate login");
    expect(parsed.value.options.mode).toBe("review");
    expect(parsed.value.options.format).toBe("xml");
    expect(parsed.value.options.output).toBe("prompt.xml");
    expect(parsed.value.options.copy).toBe(true);
    expect(parsed.value.options.budget).toBe(50000);
    expect(parsed.value.options.discover).toBe("offline");
    expect(parsed.value.options.taskFile).toBe("task.md");
    expect(parsed.value.options.include).toEqual(["src/**"]);
    expect(parsed.value.options.entrypoint).toEqual(["src/index.ts"]);
    expect(parsed.value.options.privacy).toBe("strict");
    expect(parsed.value.options.redactPattern).toEqual([
      "token_[A-Za-z0-9]+",
    ]);
    expect(parsed.value.options.neverInclude).toEqual(["**/.env"]);
  });

  test("parses subcommands and required arguments", () => {
    const templatesShow = parseCliArgs(["templates", "show", "plan"]);
    expect(templatesShow.ok).toBe(true);
    if (templatesShow.ok && templatesShow.value.kind === "templates") {
      expect(templatesShow.value.action).toBe("show");
      expect(templatesShow.value.name).toBe("plan");
    }

    const indexRebuild = parseCliArgs(["index", "--rebuild"]);
    expect(indexRebuild.ok).toBe(true);
    if (indexRebuild.ok && indexRebuild.value.kind === "index") {
      expect(indexRebuild.value.options.rebuild).toBe(true);
    }

    const manifest = parseCliArgs(["manifest", "run-123", "-o", "out.json"]);
    expect(manifest.ok).toBe(true);
    if (manifest.ok && manifest.value.kind === "manifest") {
      expect(manifest.value.target).toBe("run-123");
      expect(manifest.value.options.output).toBe("out.json");
    }
  });

  test("rejects mutually exclusive and malformed input with exit code 2", () => {
    const mutuallyExclusive = parseCliArgs(["--no-llm", "--discover", "llm"]);
    expect(mutuallyExclusive.ok).toBe(false);
    if (!mutuallyExclusive.ok) {
      expect(mutuallyExclusive.exitCode).toBe(2);
    }

    const missingTemplatesName = parseCliArgs(["templates", "show"]);
    expect(missingTemplatesName.ok).toBe(false);
    if (!missingTemplatesName.ok) {
      expect(missingTemplatesName.exitCode).toBe(2);
    }

    const unknownFlag = parseCliArgs(["--not-a-real-flag"]);
    expect(unknownFlag.ok).toBe(false);
    if (!unknownFlag.ok) {
      expect(unknownFlag.exitCode).toBe(2);
    }

    const airgapWithLlm = parseCliArgs([
      "--privacy",
      "airgap",
      "--discover",
      "llm",
    ]);
    expect(airgapWithLlm.ok).toBe(false);
    if (!airgapWithLlm.ok) {
      expect(airgapWithLlm.exitCode).toBe(2);
    }

    const airgapWithLocalCli = parseCliArgs([
      "--privacy",
      "airgap",
      "--discover",
      "local-cli",
    ]);
    expect(airgapWithLocalCli.ok).toBe(false);
    if (!airgapWithLocalCli.ok) {
      expect(airgapWithLocalCli.exitCode).toBe(2);
    }
  });

  test("run returns exit code 2 for invalid usage", () => {
    expect(run(["--no-llm", "--discover", "llm"])).toBe(2);
  });
});
