import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { CliRuntime } from "../../src/cli";
import { run } from "../../src/index";

function createRuntimeCapture(
  overrides: Partial<{
    isStdinTty: boolean;
    stdinText: string;
    files: Record<string, string>;
    links: Record<string, string>;
    copyError: string;
    pagerError: string;
  }> = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const initialFiles = { ...(overrides.files ?? {}) };
  const links = overrides.links ?? {};
  const writtenFiles: Record<string, string> = {};
  const clipboardWrites: string[] = [];
  const pagerInvocations: Array<{ path: string; pager: string }> = [];

  return {
    stdout,
    stderr,
    writtenFiles,
    clipboardWrites,
    pagerInvocations,
    runtime: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      isStdinTty: () => overrides.isStdinTty ?? true,
      readStdin: () => overrides.stdinText ?? "",
      readFile: (path: string) => {
        if (path in writtenFiles) {
          return writtenFiles[path]!;
        }
        if (!(path in initialFiles)) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        return initialFiles[path]!;
      },
      readLink: (path: string) => {
        if (!(path in links)) {
          throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
        }
        return links[path]!;
      },
      writeFile: (path: string, contents: string) => {
        writtenFiles[path] = contents;
      },
      copyToClipboard: (contents: string) => {
        clipboardWrites.push(contents);
        if (overrides.copyError) {
          return {
            ok: false as const,
            error: overrides.copyError,
          };
        }
        return { ok: true as const };
      },
      openInPager: (absolutePath: string, pagerCommand: string) => {
        pagerInvocations.push({
          path: absolutePath,
          pager: pagerCommand,
        });
        if (overrides.pagerError) {
          return {
            ok: false as const,
            error: overrides.pagerError,
          };
        }
        return { ok: true as const };
      },
    } satisfies CliRuntime,
  };
}

function expectedMainProgressLines(): string[] {
  return [
    "Scanning repository...",
    "Updating index...",
    "Discovery: using auto (default)",
    "Discovery: turn 1/1...",
    "Assembling prompt...",
    "Budget: 60000 | Estimated: 0 | Files: 0 (0 full, 0 slices, 0 codemap)",
  ];
}

function expectPromptOutputContainsTask(
  output: string | undefined,
  taskText: string,
): void {
  expect(output).toContain("<!-- CTX:BEGIN -->");
  expect(output).toContain("<task>");
  expect(output).toContain(taskText);
}

function expectProgressLinesIncluded(lines: string[]): void {
  for (const expected of expectedMainProgressLines()) {
    expect(lines).toContain(expected);
  }
}

describe("CLI subcommand routing", () => {
  test("routes main command with task text", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(["Investigate", "500s"], capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Investigate 500s");
    expectProgressLinesIncluded(capture.stderr);
  });

  test("applies --redact-pattern to final prompt output", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(
      ["Investigate SECRET_ABC12345", "--redact-pattern", "SECRET_[A-Z0-9]{8}"],
      capture.runtime,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expect(capture.stdout[0]).toContain("‹REDACTED:custom_pattern_1›");
    expect(capture.stdout[0]).not.toContain("SECRET_ABC12345");
    expect(
      capture.stderr.some((line) => /^Warning: redacted \d+ secrets$/.test(line)),
    ).toBeTrue();
  });

  test("honors --no-index by reporting persistence-disabled index status", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(["Investigate", "500s", "--no-index"], capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Investigate 500s");
    expect(capture.stdout[0]).toContain(
      "persistence=disabled (--no-index or config)",
    );
    expect(capture.stdout[0]).toContain("indexed_files=0");
    expectProgressLinesIncluded(capture.stderr);
  });

  test("emits machine-readable JSON summary to stderr with --json-summary", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(["Investigate", "500s", "--json-summary"], capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Investigate 500s");

    const summaryRaw = capture.stderr[capture.stderr.length - 1] ?? "{}";
    const summary = JSON.parse(summaryRaw) as {
      run_id: string;
      mode: string;
      discovery_backend: string;
      files_scanned: number;
      files_selected: number;
      budget: number;
      estimated_tokens: number;
      degradations_applied: number;
      duration_ms: number;
      exit_code: number;
    };

    expect(summary.run_id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/);
    expect(summary.mode).toBe("plan");
    expect(summary.discovery_backend).toBe("offline");
    expect(summary.files_scanned).toBeGreaterThan(0);
    expect(summary.files_selected).toBeGreaterThan(0);
    expect(summary.budget).toBe(60000);
    expect(summary.estimated_tokens).toBeGreaterThan(0);
    expect(summary.degradations_applied).toBeGreaterThanOrEqual(0);
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0);
    expect(summary.exit_code).toBe(0);
  });

  test("uses consistent run_id across prompt metadata and JSON summary", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(["Investigate", "500s", "--json-summary"], capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);

    const promptRunIdMatch = /\brun_id:\s*([^\n]+)/.exec(capture.stdout[0] ?? "");
    expect(promptRunIdMatch).toBeDefined();
    const promptRunId = (promptRunIdMatch?.[1] ?? "").trim();
    expect(promptRunId.length).toBeGreaterThan(0);

    const summaryRaw = capture.stderr[capture.stderr.length - 1] ?? "{}";
    const summary = JSON.parse(summaryRaw) as { run_id: string };
    expect(summary.run_id).toBe(promptRunId);
  });

  test("reports offline backend in JSON summary when dry-run overrides discovery", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(
      ["Investigate", "500s", "--dry-run", "--discover", "llm", "--json-summary"],
      capture.runtime,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("DRY RUN PLAN");

    const summaryRaw = capture.stderr[capture.stderr.length - 1] ?? "{}";
    const summary = JSON.parse(summaryRaw) as {
      discovery_backend: string;
      exit_code: number;
    };

    expect(summary.discovery_backend).toBe("offline");
    expect(summary.exit_code).toBe(0);
  });

  test("returns usage error for main command without task text", () => {
    const capture = createRuntimeCapture();
    const exitCode = run([], capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr).toEqual([
      "No task provided. Pass positional task text, pipe stdin, or use --task-file.",
    ]);
  });

  test("uses piped stdin when no positional task is provided", () => {
    const capture = createRuntimeCapture({
      isStdinTty: false,
      stdinText: "Investigate multiline task from stdin\n\n",
    });

    const exitCode = run([], capture.runtime);
    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(
      capture.stdout[0],
      "Investigate multiline task from stdin",
    );
    expectProgressLinesIncluded(capture.stderr);
  });

  test("uses --task-file when no positional/stdin task is available", () => {
    const capture = createRuntimeCapture({
      isStdinTty: true,
      files: {
        "task.md": "Task from file\n",
      },
    });

    const exitCode = run(["--task-file", "task.md"], capture.runtime);
    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Task from file");
    expectProgressLinesIncluded(capture.stderr);
  });

  test("prioritizes positional task over stdin and --task-file", () => {
    const capture = createRuntimeCapture({
      isStdinTty: false,
      stdinText: "stdin task",
      files: {
        "task.md": "file task",
      },
    });

    const exitCode = run(
      ["Use positional", "--task-file", "task.md"],
      capture.runtime,
    );
    expect(exitCode).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Use positional");
    expect(capture.stdout[0]).not.toContain("stdin task");
    expectProgressLinesIncluded(capture.stderr);
  });

  test("warns when piped stdin is unusually large", () => {
    const capture = createRuntimeCapture({
      isStdinTty: false,
      stdinText: `${"x".repeat(10_001)}\n`,
    });

    const exitCode = run([], capture.runtime);
    expect(exitCode).toBe(0);
    expect(capture.stderr[0]).toBe(
      "Warning: stdin task text exceeds 10KB; verify you did not pipe a full source file.",
    );
    expect(capture.stderr).toContain("Scanning repository...");
    expect(capture.stderr).toContain("Assembling prompt...");
  });

  test("suppresses progress and warnings with --quiet", () => {
    const capture = createRuntimeCapture({
      isStdinTty: false,
      stdinText: `${"x".repeat(10_001)}\n`,
    });

    const exitCode = run(["--quiet"], capture.runtime);
    expect(exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expectPromptOutputContainsTask(capture.stdout[0], "x");
  });

  test("adds timing suffixes with --verbose", () => {
    const capture = createRuntimeCapture();

    const exitCode = run(["Investigate", "--verbose"], capture.runtime);
    expect(exitCode).toBe(0);
    expect(capture.stderr).toContain("Scanning repository... (0ms)");
    expect(capture.stderr).toContain("Updating index... (0ms)");
    expect(capture.stderr).toContain("Discovery: using auto (default) (0ms)");
    expect(capture.stderr).toContain("Discovery: turn 1/1... (0ms)");
    expect(capture.stderr).toContain("Assembling prompt... (0ms)");
    expect(capture.stderr).toContain(
      "Budget: 60000 | Estimated: 0 | Files: 0 (0 full, 0 slices, 0 codemap)",
    );
  });

  test("warns about missing API key when llm mode is requested", () => {
    const capture = createRuntimeCapture();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;

    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const exitCode = run(["Investigate", "--discover", "llm"], capture.runtime);
      expect(exitCode).toBe(0);
      expect(capture.stderr).toContain(
        "Warning: no API key configured, using offline discovery",
      );
      expect(capture.stderr).toContain("Discovery: using llm (default)");
    } finally {
      if (previousOpenAiKey !== undefined) {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousAnthropicKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
      if (previousGoogleKey !== undefined) {
        process.env.GOOGLE_API_KEY = previousGoogleKey;
      }
    }
  });

  test("returns usage error when --task-file cannot be read", () => {
    const capture = createRuntimeCapture({
      isStdinTty: true,
    });

    const exitCode = run(["--task-file", "missing-task.md"], capture.runtime);
    expect(exitCode).toBe(2);
    expect(capture.stderr[0]).toContain("Failed to read task file:");
  });

  test("routes each subcommand to its handler", () => {
    const initRepo = mkdtempSync(`${tmpdir()}/ctx-init-`);
    writeFileSync(resolve(initRepo, ".gitignore"), "node_modules/\n", "utf8");
    const initCapture = createRuntimeCapture();
    expect(run(["init", "--repo", initRepo], initCapture.runtime)).toBe(0);
    expect(initCapture.stdout[0]).toContain(`Initialized ctx workspace at ${initRepo}`);
    expect(readFileSync(resolve(initRepo, ".ctx/config.toml"), "utf8")).toContain(
      "[defaults]",
    );
    expect(readFileSync(resolve(initRepo, ".gitignore"), "utf8")).toContain(".ctx/runs/");

    const agentsCapture = createRuntimeCapture();
    expect(run(["agents"], agentsCapture.runtime)).toBe(0);
    expect(agentsCapture.stdout[0]).toBe("agents handler pending");

    const indexRepo = mkdtempSync(`${tmpdir()}/ctx-index-`);
    const indexCapture = createRuntimeCapture();
    expect(run(["index", "--rebuild", "--repo", indexRepo], indexCapture.runtime)).toBe(0);
    expect(indexCapture.stderr).toContain("Rebuilding index...");
    expect(indexCapture.stderr).toContain("Indexing file 0/0...");
    expect(indexCapture.stdout[0]).toContain("Index rebuilt:");

    const indexStatusCapture = createRuntimeCapture();
    expect(run(["index", "--repo", indexRepo], indexStatusCapture.runtime)).toBe(0);
    expect(indexStatusCapture.stdout[0]).toContain("Index path:");
    expect(indexStatusCapture.stdout[0]).toContain("Schema version:");
    expect(indexStatusCapture.stdout[0]).toContain("Indexed files:");

    const templatesCapture = createRuntimeCapture();
    expect(run(["templates", "show", "plan"], templatesCapture.runtime)).toBe(0);
    expect(templatesCapture.stdout[0]).toContain("<ctx_metadata>");
    expect(templatesCapture.stdout[0]).toContain("mode: plan");
    expect(templatesCapture.stdout[0]).toContain("{{TASK}}");

    const artifactRepo = mkdtempSync(`${tmpdir()}/ctx-artifacts-`);
    const explainRunId = "run-123";
    const explainCapture = createRuntimeCapture({
      files: {
        [resolve(artifactRepo, ".ctx/runs/run-123/run.json")]: JSON.stringify({
          runId: explainRunId,
          task: "Review auth flow",
          config: { discovery: { discover: "offline", maxTurns: 5 } },
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 800,
            bySection: { files: 700, metadata: 100 },
            byFile: { "src/auth.ts": 700 },
            degradations: [],
          },
          timing: { phaseDurationsMs: { discovery: 42 } },
        }),
      },
      links: {
        [resolve(artifactRepo, ".ctx/runs/latest")]: explainRunId,
      },
    });
    expect(run(["explain", "last", "--repo", artifactRepo], explainCapture.runtime)).toBe(0);
    expect(explainCapture.stdout[0]).toContain("# ctx explain: run-123");
    expect(explainCapture.stdout[0]).toContain("## TASK");
    expect(explainCapture.stdout[0]).toContain("## TOKEN BUDGET");

    const manifestCapture = createRuntimeCapture({
      files: {
        [resolve(artifactRepo, ".ctx/runs/run-123/run.json")]: JSON.stringify({
          runId: explainRunId,
          task: "Review auth flow",
          config: {
            defaults: {
              mode: "review",
              format: "markdown",
              budgetTokens: 4000,
            },
            discovery: {
              discover: "offline",
              model: "n/a",
              maxTurns: 5,
            },
            git: {
              diff: "uncommitted",
            },
            privacy: {
              mode: "strict",
            },
            repo: {
              root: "/repo",
            },
          },
          selection: [
            {
              path: "src/auth.ts",
              mode: "full",
              priority: "core",
              rationale: "high score",
              priorityScore: 1200,
            },
          ],
          tokenReport: {
            budget: 1000,
            estimated: 800,
            bySection: { files: 700, metadata: 100 },
            byFile: { "src/auth.ts": 700 },
            degradations: [],
          },
          timing: { phaseDurationsMs: { discovery: 42 } },
        }),
      },
    });
    expect(run(["manifest", "run-123", "--repo", artifactRepo], manifestCapture.runtime)).toBe(0);
    const manifestJson = JSON.parse(manifestCapture.stdout[0] ?? "{}") as {
      runId: string;
      selection: Array<{ path: string }>;
      config: { mode: string; privacy: string };
    };
    expect(manifestJson.runId).toBe("run-123");
    expect(manifestJson.selection[0]?.path).toBe("src/auth.ts");
    expect(manifestJson.config.mode).toBe("review");
    expect(manifestJson.config.privacy).toBe("strict");

    const outputPath = resolve(process.cwd(), "out", "manifest.json");
    const manifestOutputCapture = createRuntimeCapture({
      files: {
        [resolve(artifactRepo, ".ctx/runs/run-123/run.json")]: JSON.stringify({
          runId: explainRunId,
          task: "Review auth flow",
          config: {
            defaults: {
              mode: "review",
              format: "markdown",
              budgetTokens: 4000,
            },
            discovery: { discover: "offline" },
            git: { diff: "off" },
            privacy: { mode: "normal" },
            repo: { root: "/repo" },
          },
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 800,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: { discovery: 12 } },
        }),
        [outputPath]: "old content",
      },
    });
    expect(
      run(
        ["manifest", "run-123", "--output", "out/manifest.json", "--repo", artifactRepo],
        manifestOutputCapture.runtime,
      ),
    ).toBe(0);
    expect(manifestOutputCapture.stderr).toContain(
      "Warning: output file 'out/manifest.json' exists and will be overwritten.",
    );
    expect(manifestOutputCapture.writtenFiles[outputPath]).toContain('"runId": "run-123"');
    expect(manifestOutputCapture.stdout).toEqual([]);

    const openCapture = createRuntimeCapture({
      files: {
        [resolve(artifactRepo, ".ctx/runs/run-123/run.json")]: JSON.stringify({
          runId: explainRunId,
          task: "Review auth flow",
          config: { discovery: { discover: "offline" } },
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 800,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: { discovery: 10 } },
        }),
        [resolve(artifactRepo, ".ctx/runs/run-123/prompt.md")]: "# Prompt\n",
      },
      links: {
        [resolve(artifactRepo, ".ctx/runs/latest")]: "run-123",
      },
    });
    expect(run(["open", "last", "--repo", artifactRepo], openCapture.runtime)).toBe(0);
    expect(openCapture.pagerInvocations[0]).toEqual({
      path: resolve(artifactRepo, ".ctx/runs/run-123/prompt.md"),
      pager: process.env.PAGER?.trim() || "less",
    });
  });

  test("init command is idempotent and does not duplicate .gitignore runs entry", () => {
    const initRepo = mkdtempSync(`${tmpdir()}/ctx-init-idempotent-`);
    writeFileSync(resolve(initRepo, ".gitignore"), ".ctx/runs/\n", "utf8");

    const firstCapture = createRuntimeCapture();
    expect(run(["init", "--repo", initRepo], firstCapture.runtime)).toBe(0);
    const secondCapture = createRuntimeCapture();
    expect(run(["init", "--repo", initRepo], secondCapture.runtime)).toBe(0);

    const gitignore = readFileSync(resolve(initRepo, ".gitignore"), "utf8");
    const runsEntries = gitignore
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.trim() === ".ctx/runs/" || line.trim() === ".ctx/runs");
    expect(runsEntries).toHaveLength(1);
    expect(secondCapture.stdout[0]).toContain("kept existing .ctx/config.toml");
    expect(secondCapture.stdout[0]).toContain("kept existing .gitignore entry for .ctx/runs/");
  });

  test("renders templates list table with built-ins", () => {
    const capture = createRuntimeCapture();
    expect(run(["templates", "list"], capture.runtime)).toBe(0);

    const output = capture.stdout[0] ?? "";
    expect(output).toContain("NAME");
    expect(output).toContain("SOURCE");
    expect(output).toContain("DESCRIPTION");
    expect(output).toContain("plan");
    expect(output).toContain("question");
    expect(output).toContain("review");
    expect(output).toContain("context");
    expect(output).toContain("built-in");
  });

  test("returns template-not-found error for templates show", () => {
    const capture = createRuntimeCapture();
    expect(run(["templates", "show", "missing_template"], capture.runtime)).toBe(3);
    expect(capture.stderr[0]).toBe("Template not found: missing_template");
  });

  test("returns explain load error when target run cannot be resolved", () => {
    const capture = createRuntimeCapture();

    const exitCode = run(["explain", "last"], capture.runtime);
    expect(exitCode).toBe(3);
    expect(capture.stderr[0]).toContain("Failed to load explain report for 'last':");
  });

  test("routes main output to --output file and suppresses stdout", () => {
    const capture = createRuntimeCapture();
    const outputPath = resolve(process.cwd(), "out", "prompt.md");

    expect(run(["Task text", "--output", "out/prompt.md"], capture.runtime)).toBe(0);
    expect(capture.stdout).toEqual([]);
    expectPromptOutputContainsTask(capture.writtenFiles[outputPath], "Task text");
  });

  test("routes main output to clipboard when --copy is set", () => {
    const capture = createRuntimeCapture();

    expect(run(["Task text", "--copy"], capture.runtime)).toBe(0);
    expect(capture.stdout).toEqual([]);
    expect(capture.clipboardWrites).toHaveLength(1);
    expectPromptOutputContainsTask(capture.clipboardWrites[0], "Task text");
  });

  test("falls back to stdout when clipboard copy fails and no output file is set", () => {
    const capture = createRuntimeCapture({
      copyError: "command not found: xclip",
    });

    expect(run(["Task text", "--copy"], capture.runtime)).toBe(0);
    expect(capture.stderr).toContain(
      "Warning: command not found: xclip; falling back to stdout.",
    );
    expect(capture.stdout).toHaveLength(1);
    expectPromptOutputContainsTask(capture.stdout[0], "Task text");
  });

  test("returns open error when prompt artifact is missing", () => {
    const capture = createRuntimeCapture({
      files: {
        [resolve(process.cwd(), ".ctx/runs/run-123/run.json")]: JSON.stringify({
          runId: "run-123",
          task: "Review auth flow",
          config: { discovery: { discover: "offline" } },
          selection: [],
          tokenReport: {
            budget: 1000,
            estimated: 800,
            bySection: {},
            byFile: {},
            degradations: [],
          },
          timing: { phaseDurationsMs: { discovery: 10 } },
        }),
      },
    });

    const exitCode = run(["open", "run-123"], capture.runtime);
    expect(exitCode).toBe(3);
    expect(capture.stderr[0]).toContain(
      "Enable config.output.store_runs to save prompts for later viewing.",
    );
  });

  test("prints dry-run plan and skips progress lines", () => {
    const capture = createRuntimeCapture();

    expect(run(["Task text", "--dry-run", "--discover", "llm"], capture.runtime)).toBe(0);
    const output = capture.stdout[0] ?? "";
    expect(output).toContain("DRY RUN PLAN");
    expect(output).toContain("task: Task text");
    expect(output).toContain("discovery_backend: offline (dry-run override)");
    expect(output).toContain("likely_includes_offline:");
    expect(output).toContain("config_summary:");
    expect(output).toContain("- discover: offline (source: dry-run override)");
    expect(capture.stderr).toEqual([]);
  });

  test("routes dry-run plan to output file and clipboard", () => {
    const capture = createRuntimeCapture();
    const outputPath = resolve(process.cwd(), "out", "dry-run.txt");

    expect(
      run(["Task text", "--dry-run", "--output", "out/dry-run.txt", "--copy"], capture.runtime),
    ).toBe(0);
    expect(capture.stdout).toEqual([]);
    expect(capture.writtenFiles[outputPath]).toContain("DRY RUN PLAN");
    expect(capture.clipboardWrites).toEqual([capture.writtenFiles[outputPath]!]);
  });
});
