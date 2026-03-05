import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  E2E_LOG_SCHEMA_VERSION,
  createRuntimeCapture,
  normalizeArtifactBundleForGolden,
  withCwd,
} from "./e2e-harness";

function writeRunFixture(repoRoot: string, runId: string): void {
  const runDir = resolve(repoRoot, ".ctx", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    resolve(runDir, "run.json"),
    JSON.stringify(
      {
        runId,
        task: "Add user authentication",
        config: {
          defaults: {
            mode: "plan",
            format: "markdown+xmltags",
            budgetTokens: 30_000,
          },
          discovery: {
            discover: "offline",
            model: "n/a",
            maxTurns: 20,
          },
          git: {
            diff: "off",
          },
          privacy: {
            mode: "normal",
          },
          repo: {
            root: repoRoot,
          },
        },
        selection: [
          {
            path: "src/auth/login.ts",
            mode: "full",
            priority: "core",
            rationale: "entrypoint auth flow",
            priorityScore: 1200,
          },
        ],
        tokenReport: {
          budget: 30_000,
          estimated: 2_500,
          bySection: {
            files: 2_000,
            metadata: 500,
          },
          byFile: {
            "src/auth/login.ts": 2_000,
          },
          degradations: [],
        },
        timing: {
          phaseDurationsMs: {
            discovery: 42,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    resolve(runDir, "prompt.md"),
    [
      "<ctx_metadata>",
      `run_id: ${runId}`,
      "</ctx_metadata>",
      "<task>",
      "Add user authentication",
      "</task>",
    ].join("\n"),
    "utf8",
  );

  const latestLinkPath = resolve(repoRoot, ".ctx", "runs", "latest");
  try {
    symlinkSync(runId, latestLinkPath);
  } catch {
    // The symlink may already exist in repeated fixture writes.
  }
}

function writeRunRecordOnly(repoRoot: string, runId: string): void {
  const runDir = resolve(repoRoot, ".ctx", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    resolve(runDir, "run.json"),
    JSON.stringify(
      {
        runId,
        task: "Failure-path fixture task",
        config: {
          defaults: {
            mode: "plan",
            format: "markdown+xmltags",
            budgetTokens: 30_000,
          },
          discovery: {
            discover: "offline",
            model: "n/a",
            maxTurns: 20,
          },
          git: {
            diff: "off",
          },
          privacy: {
            mode: "normal",
          },
          repo: {
            root: repoRoot,
          },
        },
        selection: [],
        tokenReport: {
          budget: 30_000,
          estimated: 1_000,
          bySection: {
            files: 0,
            metadata: 1000,
          },
          byFile: {},
          degradations: [],
        },
        timing: {
          phaseDurationsMs: {
            discovery: 10,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function normalizeRunSpecificValues(value: string): string {
  return value.replace(/run_id:\s+[^\n]+/g, "run_id: <run-id>");
}

function parseJsonLines<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as T);
}

describe("CLI end-to-end integration", () => {
  test("executes main, explain, manifest, open, and output-routing flows", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-`);
    mkdirSync(resolve(repoRoot, "src", "auth"), { recursive: true });
    mkdirSync(resolve(repoRoot, "test", "auth"), { recursive: true });

    writeFileSync(
      resolve(repoRoot, "package.json"),
      JSON.stringify({ name: "ctx-e2e-fixture", version: "1.0.0" }, null, 2),
      "utf8",
    );
    writeFileSync(
      resolve(repoRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
      "utf8",
    );
    writeFileSync(
      resolve(repoRoot, "src", "auth", "login.ts"),
      "export function login() { return true; }\n",
      "utf8",
    );
    writeFileSync(
      resolve(repoRoot, "test", "auth", "login.test.ts"),
      "import { login } from '../../src/auth/login';\n",
      "utf8",
    );

    writeRunFixture(repoRoot, "run-e2e");

    const mainCapture = createRuntimeCapture();
    const dryRunCapture = createRuntimeCapture();
    const explainCapture = createRuntimeCapture();
    const manifestCapture = createRuntimeCapture();
    const openCapture = createRuntimeCapture();
    const copyCapture = createRuntimeCapture();
    const outputCapture = createRuntimeCapture();

    withCwd(repoRoot, () => {
      const mainExit = mainCapture.runCommand({
        testCaseId: "main-flow",
        step: "main",
        argv: ["--no-llm", "--budget", "30000", "Add user authentication"],
      });
      expect(mainExit).toBe(0);
      expect(mainCapture.stdout[0]).toContain("Add user authentication");
      expect(mainCapture.stderr).toContain("Scanning repository...");
      expect(mainCapture.stderr).toContain("Assembling prompt...");
      expect(mainCapture.assertionEvents).toHaveLength(1);
      expect(mainCapture.assertionEvents[0]).toEqual(
        expect.objectContaining({
          schema_version: E2E_LOG_SCHEMA_VERSION,
          channel: "assertion",
          event: "command_result",
          run_id: "main-flow-001",
          test_case_id: "main-flow",
          step: "main",
          command: "ctx --no-llm --budget 30000 \"Add user authentication\"",
          env_flags: expect.objectContaining({
            dry_run: false,
            no_llm: true,
          }),
          exit_code: 0,
        }),
      );

      const dryRunPath = resolve(repoRoot, "artifacts", "dry-run.txt");
      const dryRunExit = dryRunCapture.runCommand({
        testCaseId: "main-flow",
        step: "dry-run",
        argv: [
          "--dry-run",
          "--discover",
          "llm",
          "--json-summary",
          "--output",
          "artifacts/dry-run.txt",
          "Add user authentication",
        ],
      });
      expect(dryRunExit).toBe(0);
      expect(dryRunCapture.stdout).toEqual([]);
      expect(readFileSync(dryRunPath, "utf8")).toContain("DRY RUN PLAN");
      expect(readFileSync(dryRunPath, "utf8")).toContain(
        "discovery_backend: offline (dry-run override)",
      );
      const dryRunSummaryLine = dryRunCapture.stderr.find((line) =>
        line.trim().startsWith("{")
      );
      const dryRunSummary = JSON.parse(dryRunSummaryLine ?? "{}") as {
        discovery_backend: string;
        exit_code: number;
      };
      expect(dryRunSummary.discovery_backend).toBe("offline");
      expect(dryRunSummary.exit_code).toBe(0);
      expect(dryRunCapture.assertionEvents[0]?.env_flags).toEqual(
        expect.objectContaining({
          dry_run: true,
          json_summary: true,
          discover_mode: "llm",
        }),
      );

      const explainExit = explainCapture.runCommand({
        testCaseId: "main-flow",
        step: "explain",
        argv: ["explain", "run-e2e"],
      });
      expect(explainExit).toBe(0);
      expect(explainCapture.stdout[0]).toContain("# ctx explain: run-e2e");
      expect(explainCapture.stdout[0]).toContain("## TASK");

      const manifestExit = manifestCapture.runCommand({
        testCaseId: "main-flow",
        step: "manifest",
        argv: ["manifest", "run-e2e"],
      });
      expect(manifestExit).toBe(0);
      const manifestJson = JSON.parse(manifestCapture.stdout[0] ?? "{}") as {
        runId: string;
        selection: Array<{ path: string }>;
        config: { mode: string; discover: string };
      };
      expect(manifestJson.runId).toBe("run-e2e");
      expect(manifestJson.config.mode).toBe("plan");
      expect(manifestJson.config.discover).toBe("offline");
      expect(manifestJson.selection[0]?.path).toBe("src/auth/login.ts");

      const openExit = openCapture.runCommand({
        testCaseId: "main-flow",
        step: "open",
        argv: ["open", "run-e2e"],
      });
      expect(openExit).toBe(0);
      expect(openCapture.pagerInvocations).toHaveLength(1);
      expect(openCapture.pagerInvocations[0]?.path).toContain(
        "/.ctx/runs/run-e2e/prompt.md",
      );

      const copyExit = copyCapture.runCommand({
        testCaseId: "main-flow",
        step: "copy",
        argv: ["Task text", "--copy"],
      });
      expect(copyExit).toBe(0);
      expect(copyCapture.clipboardWrites[0]).toContain("Task text");

      const outputPath = resolve(repoRoot, "artifacts", "out.md");
      const outputExit = outputCapture.runCommand({
        testCaseId: "main-flow",
        step: "output",
        argv: ["Task text", "--output", "artifacts/out.md"],
      });
      expect(outputExit).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toContain("Task text");

      const mainArtifact = mainCapture.commandArtifacts[0]!;
      const mainTranscript = JSON.parse(
        readFileSync(mainArtifact.transcript_path, "utf8"),
      ) as {
        run_id: string;
        stderr_line_count: number;
        diagnostics_emitted: number;
      };
      expect(mainTranscript.run_id).toBe("main-flow-001");
      expect(mainTranscript.stderr_line_count).toBeGreaterThan(0);
      expect(mainTranscript.diagnostics_emitted).toBeGreaterThan(0);

      const dryRunArtifact = dryRunCapture.commandArtifacts[0]!;
      const dryRunOutputFiles = JSON.parse(
        readFileSync(dryRunArtifact.output_files_path, "utf8"),
      ) as Array<{ path: string; exists: boolean; content_preview: string }>;
      expect(dryRunOutputFiles[0]?.path).toBe("artifacts/dry-run.txt");
      expect(dryRunOutputFiles[0]?.exists).toBe(true);
      expect(dryRunOutputFiles[0]?.content_preview).toContain("DRY RUN PLAN");

      const outputArtifact = outputCapture.commandArtifacts[0]!;
      const outputFiles = JSON.parse(
        readFileSync(outputArtifact.output_files_path, "utf8"),
      ) as Array<{ path: string; exists: boolean; content_preview: string }>;
      expect(outputFiles[0]?.path).toBe("artifacts/out.md");
      expect(outputFiles[0]?.exists).toBe(true);
      expect(outputFiles[0]?.content_preview).toContain("Task text");
    });
  });

  test("covers happy-path mode/format matrix with structured logs", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-mode-format-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "entry.ts"),
      "export const entry = true;\n",
      "utf8",
    );

    const scenarios: Array<{
      step: string;
      argv: string[];
      expectedSubstrings: string[];
    }> = [
      {
        step: "plan-default",
        argv: ["--no-llm", "--mode", "plan", "Plan mode matrix task"],
        expectedSubstrings: ["<!-- CTX:BEGIN -->", "mode: plan"],
      },
      {
        step: "review-markdown",
        argv: [
          "--no-llm",
          "--mode",
          "review",
          "--format",
          "markdown",
          "Review mode matrix task",
        ],
        expectedSubstrings: ["## Metadata", "mode: review", "## Manifest"],
      },
      {
        step: "question-plain",
        argv: [
          "--no-llm",
          "--mode",
          "question",
          "--format",
          "plain",
          "Question mode matrix task",
        ],
        expectedSubstrings: ["Metadata:", "mode: question", "Manifest:"],
      },
      {
        step: "context-xml",
        argv: [
          "--no-llm",
          "--mode",
          "context",
          "--format",
          "xml",
          "Context mode matrix task",
        ],
        expectedSubstrings: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<ctx_prompt>",
          "mode: context",
        ],
      },
    ];

    for (const scenario of scenarios) {
      const capture = createRuntimeCapture({ verbosity: "ci" });
      withCwd(repoRoot, () => {
        const exitCode = capture.runCommand({
          testCaseId: "mode-format-matrix",
          step: scenario.step,
          argv: scenario.argv,
        });
        expect(exitCode).toBe(0);
      });

      const output = capture.stdout[0] ?? "";
      for (const expectedSubstring of scenario.expectedSubstrings) {
        expect(output).toContain(expectedSubstring);
      }

      expect(capture.assertionEvents).toHaveLength(1);
      expect(capture.assertionEvents[0]?.step).toBe(scenario.step);
      expect(capture.assertionEvents[0]?.exit_code).toBe(0);
      expect(capture.assertionEvents[0]?.stdout_line_count).toBeGreaterThan(0);
      expect(capture.diagnosticEvents.length).toBeGreaterThan(0);

      const transcript = JSON.parse(
        readFileSync(capture.commandArtifacts[0]!.transcript_path, "utf8"),
      ) as {
        step: string;
        run_id: string;
      };
      expect(transcript.step).toBe(scenario.step);
      expect(transcript.run_id).toBe("mode-format-matrix-001");
    }
  });

  test("produces deterministic happy-path output across repeated runs", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-repeatability-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "repeat.ts"),
      "export const repeatable = true;\n",
      "utf8",
    );

    const capture = createRuntimeCapture({ verbosity: "ci" });
    const argv = ["--no-llm", "Repeatability matrix task"];

    withCwd(repoRoot, () => {
      expect(
        capture.runCommand({
          testCaseId: "repeatability",
          step: "run-1",
          argv,
        }),
      ).toBe(0);
      expect(
        capture.runCommand({
          testCaseId: "repeatability",
          step: "run-2",
          argv,
        }),
      ).toBe(0);
    });

    const output1 = normalizeRunSpecificValues(capture.stdout[0] ?? "");
    const output2 = normalizeRunSpecificValues(capture.stdout[1] ?? "");
    expect(output1).toBe(output2);

    expect(capture.assertionEvents).toHaveLength(2);
    const first = capture.assertionEvents[0]!;
    const second = capture.assertionEvents[1]!;
    expect(first.env_flags).toEqual(second.env_flags);
    expect(first.exit_code).toBe(0);
    expect(second.exit_code).toBe(0);

    const firstStderr = capture.stderr.slice(0, first.stderr_line_count).join("\n");
    const secondStderr = capture.stderr
      .slice(first.stderr_line_count, first.stderr_line_count + second.stderr_line_count)
      .join("\n");
    expect(firstStderr).toBe(secondStderr);
  });

  test("captures root-cause diagnostics for failure-path scenarios", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-failures-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "failure.ts"),
      "export const failurePath = true;\n",
      "utf8",
    );
    writeFileSync(resolve(repoRoot, "src", "tiny.ts"), "a", "utf8");
    writeRunRecordOnly(repoRoot, "run-no-prompt");
    mkdirSync(resolve(repoRoot, "blocked-output"), { recursive: true });

    const scenarios: Array<{
      step: string;
      argv: string[];
      expectedExit: number;
      expectedBreadcrumb: string;
    }> = [
      {
        step: "missing-task-file",
        argv: ["--task-file", "missing-task.md"],
        expectedExit: 2,
        expectedBreadcrumb: "Failed to read task file",
      },
      {
        step: "missing-explain-run",
        argv: ["explain", "missing-run"],
        expectedExit: 3,
        expectedBreadcrumb: "Failed to load explain report for 'missing-run'",
      },
      {
        step: "open-missing-prompt",
        argv: ["open", "run-no-prompt"],
        expectedExit: 3,
        expectedBreadcrumb: "Prompt artifact not found for run 'run-no-prompt'",
      },
      {
        step: "output-permission-error",
        argv: ["--output", "blocked-output", "Failure output path"],
        expectedExit: 3,
        expectedBreadcrumb: "Failed to write output file 'blocked-output'",
      },
      {
        step: "llm-no-key-fallback",
        argv: ["--discover", "llm", "Fallback without API key"],
        expectedExit: 0,
        expectedBreadcrumb: "no API key configured, using offline discovery",
      },
      {
        step: "size-exclusion-warning",
        argv: ["--max-file-bytes", "1", "Size warning coverage"],
        expectedExit: 0,
        expectedBreadcrumb: "files exceeded size limit",
      },
    ];

    for (const scenario of scenarios) {
      const capture = createRuntimeCapture({ verbosity: "ci" });

      withCwd(repoRoot, () => {
        const exitCode = capture.runCommand({
          testCaseId: "failure-matrix",
          step: scenario.step,
          argv: scenario.argv,
        });
        expect(exitCode).toBe(scenario.expectedExit);
      });

      const stderrCombined = capture.stderr.join("\n");
      expect(stderrCombined).toContain(scenario.expectedBreadcrumb);

      const bundle = capture.commandArtifacts[0]!;
      const transcript = JSON.parse(readFileSync(bundle.transcript_path, "utf8")) as {
        step: string;
        exit_code: number;
        diagnostics_emitted: number;
      };
      expect(transcript.step).toBe(scenario.step);
      expect(transcript.exit_code).toBe(scenario.expectedExit);
      expect(transcript.diagnostics_emitted).toBeGreaterThan(0);

      const stderrTimeline = JSON.parse(readFileSync(bundle.stderr_timeline_path, "utf8")) as
        Array<{ message: string }>;
      expect(
        stderrTimeline.some((entry) => entry.message.includes(scenario.expectedBreadcrumb)),
      ).toBe(true);

      const diagnosticRows = parseJsonLines<{ message: string }>(bundle.diagnostic_events_path);
      expect(
        diagnosticRows.some((entry) => entry.message.includes(scenario.expectedBreadcrumb)),
      ).toBe(true);
    }
  });

  test("updates latest run pointer when a prior latest symlink already exists", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-latest-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });

    writeFileSync(
      resolve(repoRoot, "package.json"),
      JSON.stringify({ name: "ctx-e2e-latest", version: "1.0.0" }, null, 2),
      "utf8",
    );
    writeFileSync(
      resolve(repoRoot, "src", "index.ts"),
      "export const value = 1;\n",
      "utf8",
    );

    writeRunFixture(repoRoot, "run-old");

    const mainCapture = createRuntimeCapture();
    const explainCapture = createRuntimeCapture();

    withCwd(repoRoot, () => {
      const mainExit = mainCapture.runCommand({
        testCaseId: "latest-pointer",
        step: "main",
        argv: ["Newest task should be latest"],
      });
      expect(mainExit).toBe(0);

      const explainExit = explainCapture.runCommand({
        testCaseId: "latest-pointer",
        step: "explain-last",
        argv: ["explain", "last"],
      });
      expect(explainExit).toBe(0);
      expect(explainCapture.stdout[0]).toContain("Newest task should be latest");
      expect(explainCapture.stdout[0]).not.toContain("Add user authentication");
    });
  });

  test("uses deterministic task-source precedence: positional > stdin > task-file", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-precedence-`);
    mkdirSync(resolve(repoRoot, "tasks"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "tasks", "task.md"),
      "FILE_TASK_PRECEDENCE_789",
      "utf8",
    );

    const positionalCapture = createRuntimeCapture();
    positionalCapture.runtime.isStdinTty = () => false;
    positionalCapture.runtime.readStdin = () => "STDIN_TASK_PRECEDENCE_456";

    const stdinCapture = createRuntimeCapture();
    stdinCapture.runtime.isStdinTty = () => false;
    stdinCapture.runtime.readStdin = () => "STDIN_TASK_PRECEDENCE_456";

    const taskFileCapture = createRuntimeCapture();

    withCwd(repoRoot, () => {
      const positionalExit = positionalCapture.runCommand({
        testCaseId: "task-source-precedence",
        step: "positional",
        argv: [
          "--task-file",
          "tasks/task.md",
          "POSITIONAL_TASK_PRECEDENCE_123",
        ],
      });
      expect(positionalExit).toBe(0);
      expect(positionalCapture.stdout[0]).toContain("POSITIONAL_TASK_PRECEDENCE_123");
      expect(positionalCapture.stdout[0]).not.toContain("STDIN_TASK_PRECEDENCE_456");

      const stdinExit = stdinCapture.runCommand({
        testCaseId: "task-source-precedence",
        step: "stdin",
        argv: ["--task-file", "tasks/task.md"],
      });
      expect(stdinExit).toBe(0);
      expect(stdinCapture.stdout[0]).toContain("STDIN_TASK_PRECEDENCE_456");

      const taskFileExit = taskFileCapture.runCommand({
        testCaseId: "task-source-precedence",
        step: "task-file",
        argv: ["--task-file", "tasks/task.md"],
      });
      expect(taskFileExit).toBe(0);
      expect(taskFileCapture.stdout[0]).toContain("FILE_TASK_PRECEDENCE_789");
    });
  });

  test("captures backend selection and fallback matrix decisions in stderr/json summary", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-backend-matrix-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(resolve(repoRoot, "src", "backend.ts"), "export const v = 1;\n", "utf8");

    const scenarios: Array<{
      step: string;
      argv: string[];
      expectDryRunOverrideText?: boolean;
      expectedDiscoverModeFlag: string;
    }> = [
      {
        step: "forced-offline",
        argv: ["--discover", "offline", "--json-summary", "Offline backend matrix task"],
        expectedDiscoverModeFlag: "offline",
      },
      {
        step: "llm-no-key-fallback",
        argv: ["--discover", "llm", "--json-summary", "LLM fallback matrix task"],
        expectedDiscoverModeFlag: "llm",
      },
      {
        step: "local-cli-fallback",
        argv: ["--discover", "local-cli", "--json-summary", "Local CLI fallback matrix task"],
        expectedDiscoverModeFlag: "local-cli",
      },
      {
        step: "dry-run-override",
        argv: [
          "--dry-run",
          "--discover",
          "llm",
          "--json-summary",
          "Dry run override matrix task",
        ],
        expectedDiscoverModeFlag: "llm",
        expectDryRunOverrideText: true,
      },
    ];

    for (const scenario of scenarios) {
      const capture = createRuntimeCapture({ verbosity: "ci" });
      withCwd(repoRoot, () => {
        const exitCode = capture.runCommand({
          testCaseId: "backend-matrix",
          step: scenario.step,
          argv: scenario.argv,
        });
        expect(exitCode).toBe(0);
      });

      const summaryLine = capture.stderr.find((line) => line.trim().startsWith("{"));
      expect(summaryLine).toBeDefined();
      const summary = JSON.parse(summaryLine ?? "{}") as {
        discovery_backend: string;
        exit_code: number;
      };
      expect(summary.discovery_backend).toBe("offline");
      expect(summary.exit_code).toBe(0);

      const assertion = capture.assertionEvents[0];
      expect(assertion?.env_flags.discover_mode).toBe(
        scenario.expectedDiscoverModeFlag,
      );
      expect(assertion?.env_flags.json_summary).toBeTrue();

      if (scenario.expectDryRunOverrideText) {
        expect(capture.stdout[0]).toContain("discovery_backend: offline (dry-run override)");
      }
    }
  });

  test("matches deterministic golden-like snapshot for diagnostic bundle", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-golden-bundle-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(resolve(repoRoot, "src", "golden.ts"), "export const golden = 1;\n", "utf8");

    const capture = createRuntimeCapture({ verbosity: "ci" });
    withCwd(repoRoot, () => {
      const exitCode = capture.runCommand({
        testCaseId: "golden-bundle",
        step: "main",
        argv: ["--no-llm", "Golden bundle deterministic task"],
      });
      expect(exitCode).toBe(0);
    });

    const bundle = capture.commandArtifacts[0]!;
    const normalized = normalizeArtifactBundleForGolden(bundle);
    const expectedPath = resolve(
      process.cwd(),
      "test/fixtures/golden-snapshots/e2e-diagnostic-bundle.json",
    );
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(normalized).toEqual(expected);
  });

  test("emits stable structured assertion logs and redacted diagnostic logs", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-logging-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "index.ts"),
      "export const value = 1;\n",
      "utf8",
    );

    const capture = createRuntimeCapture();
    const secret = `ghp_${"a".repeat(36)}`;

    withCwd(repoRoot, () => {
      const exitCode = capture.runCommand({
        testCaseId: "logging-contract",
        step: "main-redaction",
        argv: ["--no-llm", "--redact", "off", `Investigate ${secret}`],
      });
      expect(exitCode).toBe(0);
    });

    expect(capture.assertionEvents).toHaveLength(1);
    const assertion = capture.assertionEvents[0]!;
    expect(assertion).toEqual(
      expect.objectContaining({
        schema_version: E2E_LOG_SCHEMA_VERSION,
        channel: "assertion",
        event: "command_result",
        run_id: "logging-contract-001",
        test_case_id: "logging-contract",
        step: "main-redaction",
        cwd: repoRoot,
        env_flags: expect.objectContaining({
          no_llm: true,
          redact_mode: "off",
          dry_run: false,
        }),
        exit_code: 0,
      }),
    );
    expect(assertion.duration_ms).toBeGreaterThanOrEqual(0);
    expect(assertion.stdout_line_count).toBeGreaterThan(0);
    expect(assertion.command).toContain("‹REDACTED:github_token›");
    expect(assertion.command).not.toContain(secret);

    const rawStdout = capture.stdout.join("\n");
    expect(rawStdout).toContain(secret);

    const diagnosticsCombined = capture.diagnosticEvents
      .map((event) => event.message)
      .join("\n");
    expect(diagnosticsCombined).not.toContain(secret);
    expect(diagnosticsCombined).toContain("‹REDACTED:github_token›");
    expect(capture.diagnosticEvents.every((event) => event.channel === "diagnostic")).toBe(
      true,
    );
    expect(capture.diagnosticEvents.every((event) => event.cwd === repoRoot)).toBe(true);
    expect(capture.diagnosticEvents.some((event) => event.redaction_count > 0)).toBe(
      true,
    );
  });

  test("redacts output file previews in artifact bundles", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-output-redaction-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "index.ts"),
      "export const value = 1;\n",
      "utf8",
    );

    const capture = createRuntimeCapture({ verbosity: "ci" });
    const secret = `ghp_${"b".repeat(36)}`;

    withCwd(repoRoot, () => {
      const exitCode = capture.runCommand({
        testCaseId: "output-redaction",
        step: "write-output",
        argv: [
          "--no-llm",
          "--redact",
          "off",
          "--output",
          "artifacts/leak.md",
          `Investigate ${secret}`,
        ],
      });
      expect(exitCode).toBe(0);
    });

    const writtenOutput = readFileSync(resolve(repoRoot, "artifacts/leak.md"), "utf8");
    expect(writtenOutput).toContain(secret);

    const bundle = capture.commandArtifacts[0]!;
    const outputFiles = JSON.parse(readFileSync(bundle.output_files_path, "utf8")) as Array<{
      path: string;
      content_preview: string;
      redaction_count: number;
    }>;
    expect(outputFiles[0]?.path).toBe("artifacts/leak.md");
    expect(outputFiles[0]?.redaction_count).toBeGreaterThan(0);
    expect(outputFiles[0]?.content_preview).toContain("‹REDACTED:github_token›");
    expect(outputFiles[0]?.content_preview).not.toContain(secret);
  });

  test("supports local vs ci artifact verbosity levels in reusable harness", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-verbosity-`);
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "src", "index.ts"),
      "export const value = 1;\n",
      "utf8",
    );

    const longTask = `Investigate ${"x".repeat(18_000)}`;
    const localCapture = createRuntimeCapture({ verbosity: "local" });
    const ciCapture = createRuntimeCapture({ verbosity: "ci" });

    withCwd(repoRoot, () => {
      expect(
        localCapture.runCommand({
          testCaseId: "verbosity",
          step: "local",
          argv: ["--output", "artifacts/local.md", longTask],
        }),
      ).toBe(0);
      expect(
        ciCapture.runCommand({
          testCaseId: "verbosity",
          step: "ci",
          argv: ["--output", "artifacts/ci.md", longTask],
        }),
      ).toBe(0);
    });

    const localBundle = localCapture.commandArtifacts[0]!;
    const ciBundle = ciCapture.commandArtifacts[0]!;
    const localTranscript = JSON.parse(
      readFileSync(localBundle.transcript_path, "utf8"),
    ) as {
      verbosity: string;
      diagnostics_truncated: boolean;
    };
    const ciTranscript = JSON.parse(readFileSync(ciBundle.transcript_path, "utf8")) as {
      verbosity: string;
      diagnostics_truncated: boolean;
    };
    expect(localTranscript.verbosity).toBe("local");
    expect(ciTranscript.verbosity).toBe("ci");
    expect(ciTranscript.diagnostics_truncated).toBeFalse();

    const localOutputFiles = JSON.parse(
      readFileSync(localBundle.output_files_path, "utf8"),
    ) as Array<{ path: string; truncated: boolean; content_preview: string }>;
    const ciOutputFiles = JSON.parse(
      readFileSync(ciBundle.output_files_path, "utf8"),
    ) as Array<{ path: string; truncated: boolean; content_preview: string }>;

    expect(localOutputFiles[0]?.path).toBe("artifacts/local.md");
    expect(ciOutputFiles[0]?.path).toBe("artifacts/ci.md");
    expect(localOutputFiles[0]?.truncated).toBeTrue();
    expect(ciOutputFiles[0]?.truncated).toBeFalse();
    expect(ciOutputFiles[0]?.content_preview.length).toBeGreaterThan(
      localOutputFiles[0]?.content_preview.length ?? 0,
    );
  });

  test("returns usage error for invalid args and still works outside git", () => {
    const repoRoot = mkdtempSync(`${tmpdir()}/ctx-e2e-nongit-`);
    writeFileSync(
      resolve(repoRoot, "README.md"),
      "# non-git fixture\n",
      "utf8",
    );

    const invalidCapture = createRuntimeCapture();
    const noGitCapture = createRuntimeCapture();

    withCwd(repoRoot, () => {
      expect(
        invalidCapture.runCommand({
          testCaseId: "invalid-args",
          step: "invalid-mode",
          argv: ["--mode", "invalid"],
        }),
      ).toBe(2);
      expect(invalidCapture.stderr[0]).toContain("Option --mode must be one of");

      expect(
        noGitCapture.runCommand({
          testCaseId: "invalid-args",
          step: "non-git-main",
          argv: ["Explain setup"],
        }),
      ).toBe(0);
      expect(noGitCapture.stdout[0]).toContain("Explain setup");
    });
  });
});
