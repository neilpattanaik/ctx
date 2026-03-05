import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import type { CliRuntime } from "../../src/cli";
import { run } from "../../src/index";
import {
  compileExtraRedactPatterns,
  redactText,
  type SecretPatternEntry,
} from "../../src/privacy";

export const E2E_LOG_SCHEMA_VERSION = "ctx-e2e-log.v1";

export type E2eArtifactVerbosity = "local" | "ci";

export interface E2eEnvFlags {
  dry_run: boolean;
  json_summary: boolean;
  no_llm: boolean;
  quiet: boolean;
  verbose: boolean;
  discover_mode: string;
  redact_mode: string;
  redact_pattern_count: number;
}

export interface E2eEventBase {
  schema_version: typeof E2E_LOG_SCHEMA_VERSION;
  run_id: string;
  test_case_id: string;
  step: string;
  command: string;
  cwd: string;
  env_flags: E2eEnvFlags;
}

export interface E2eAssertionEvent extends E2eEventBase {
  channel: "assertion";
  event: "command_result";
  duration_ms: number;
  exit_code: number;
  stdout_line_count: number;
  stderr_line_count: number;
}

export interface E2eDiagnosticEvent extends E2eEventBase {
  channel: "diagnostic";
  event: "stdout_line" | "stderr_line";
  message: string;
  redaction_count: number;
  timestamp_ms: number;
}

export interface E2eCommandInput {
  testCaseId: string;
  step: string;
  argv: string[];
}

export interface E2eOutputFileSnapshot {
  path: string;
  absolute_path: string;
  exists: boolean;
  size_bytes: number;
  content_preview: string;
  redaction_count: number;
  truncated: boolean;
}

export interface E2eRunArtifactEntry {
  path: string;
  kind: "file" | "symlink";
  size_bytes: number | null;
}

export interface E2eCommandArtifactBundle {
  run_id: string;
  test_case_id: string;
  step: string;
  bundle_dir: string;
  transcript_path: string;
  stderr_timeline_path: string;
  output_files_path: string;
  run_artifacts_path: string;
  assertion_events_path: string;
  diagnostic_events_path: string;
  verbosity: E2eArtifactVerbosity;
}

export interface E2eGoldenTranscriptSnapshot {
  schema_version: string;
  step: string;
  env_flags: E2eEnvFlags;
  exit_code: number;
  stdout_line_count: number;
  stderr_line_count: number;
  diagnostics_emitted: number;
}

export interface E2eGoldenDiagnosticSnapshot {
  event: string;
  message: string;
  redaction_count: number;
}

export interface E2eGoldenBundleSnapshot {
  transcript: E2eGoldenTranscriptSnapshot;
  stderr_messages: string[];
  diagnostic_events: E2eGoldenDiagnosticSnapshot[];
  output_files: Array<{
    path: string;
    exists: boolean;
    truncated: boolean;
    redaction_count: number;
  }>;
}

interface ActiveCommandContext extends E2eEventBase {
  argv: readonly string[];
  startedAtMs: number;
  stdoutStartIndex: number;
  stderrStartIndex: number;
  clipboardStartIndex: number;
  pagerStartIndex: number;
  diagnosticStartIndex: number;
  redactionPatterns: readonly SecretPatternEntry[];
}

export interface RuntimeCaptureOptions {
  artifactRoot?: string;
  verbosity?: E2eArtifactVerbosity;
}

function quoteShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function formatCommand(argv: readonly string[]): string {
  return `ctx ${argv.map((part) => quoteShellArg(part)).join(" ")}`.trim();
}

function collectOptionValues(argv: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option && index + 1 < argv.length) {
      values.push(argv[index + 1] ?? "");
    }
  }
  return values;
}

function findLastOptionValue(argv: readonly string[], option: string): string | undefined {
  const values = collectOptionValues(argv, option);
  return values.length === 0 ? undefined : values[values.length - 1];
}

function parseEnvFlags(argv: readonly string[]): {
  envFlags: E2eEnvFlags;
  redactionPatterns: readonly SecretPatternEntry[];
} {
  const redactPatterns = collectOptionValues(argv, "--redact-pattern");
  const compiledPatterns = compileExtraRedactPatterns(redactPatterns);

  return {
    envFlags: {
      dry_run: argv.includes("--dry-run"),
      json_summary: argv.includes("--json-summary"),
      no_llm: argv.includes("--no-llm"),
      quiet: argv.includes("--quiet"),
      verbose: argv.includes("--verbose"),
      discover_mode: findLastOptionValue(argv, "--discover") ?? "auto",
      redact_mode: findLastOptionValue(argv, "--redact") ?? "default",
      redact_pattern_count: compiledPatterns.patterns.length,
    },
    redactionPatterns: compiledPatterns.patterns,
  };
}

function clampPreview(value: string, verbosity: E2eArtifactVerbosity): {
  text: string;
  truncated: boolean;
} {
  const limit = verbosity === "ci" ? 24_000 : 4_000;
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`,
    truncated: true,
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function toRelativePath(base: string, target: string): string {
  const normalized = relative(base, target).replace(/\\/g, "/");
  return normalized.length === 0 ? "." : normalized;
}

function collectRunArtifactEntries(
  repoRoot: string,
  verbosity: E2eArtifactVerbosity,
): {
  entries: E2eRunArtifactEntry[];
  truncated: boolean;
} {
  const root = resolve(repoRoot, ".ctx", "runs");
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { entries: [], truncated: false };
  }
  if (!rootStat.isDirectory()) {
    return { entries: [], truncated: false };
  }

  const maxEntries = verbosity === "ci" ? 600 : 200;
  const results: E2eRunArtifactEntry[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && results.length < maxEntries) {
    const current = queue.shift()!;
    let children;
    try {
      children = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      continue;
    }

    for (const child of children) {
      const absolutePath = resolve(current, child.name);
      if (child.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (results.length >= maxEntries) {
        break;
      }
      if (child.isFile()) {
        let sizeBytes: number | null = null;
        try {
          sizeBytes = statSync(absolutePath).size;
        } catch {
          sizeBytes = null;
        }
        results.push({
          path: toRelativePath(root, absolutePath),
          kind: "file",
          size_bytes: sizeBytes,
        });
        continue;
      }
      if (child.isSymbolicLink()) {
        results.push({
          path: toRelativePath(root, absolutePath),
          kind: "symlink",
          size_bytes: null,
        });
      }
    }
  }

  return {
    entries: results,
    truncated: queue.length > 0,
  };
}

function collectOutputFileSnapshots(
  argv: readonly string[],
  cwd: string,
  verbosity: E2eArtifactVerbosity,
  redactionPatterns: readonly SecretPatternEntry[],
): E2eOutputFileSnapshot[] {
  const outputPaths = collectOptionValues(argv, "--output");
  const snapshots: E2eOutputFileSnapshot[] = [];

  for (const outputPath of outputPaths) {
    const absolutePath = resolve(cwd, outputPath);
    try {
      const contents = readFileSync(absolutePath, "utf8");
      const redacted = redactText(contents, {
        extraPatterns: redactionPatterns,
      });
      const preview = clampPreview(redacted.text, verbosity);
      snapshots.push({
        path: outputPath,
        absolute_path: absolutePath,
        exists: true,
        size_bytes: contents.length,
        content_preview: preview.text,
        redaction_count: redacted.redactionCount,
        truncated: preview.truncated,
      });
    } catch {
      snapshots.push({
        path: outputPath,
        absolute_path: absolutePath,
        exists: false,
        size_bytes: 0,
        content_preview: "",
        redaction_count: 0,
        truncated: false,
      });
    }
  }

  return snapshots;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function writeJsonLines(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(path, body.length === 0 ? "" : `${body}\n`, "utf8");
}

function readJsonLines<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as T);
}

function normalizeDynamicText(value: string): string {
  return value
    .replace(/\brun_id:\s*[a-f0-9]{8}\b/gi, "run_id: <run-id>")
    .replace(/\b\d{8}T\d{6}-[0-9a-f]{8}\b/g, "<run-id>")
    .replace(/\/tmp\/ctx-[^/\s]+/g, "<tmp-repo>");
}

export function createTempRepo(prefix = "ctx-e2e-"): string {
  return mkdtempSync(`${tmpdir()}/${prefix}`);
}

export function normalizeArtifactBundleForGolden(
  bundle: E2eCommandArtifactBundle,
): E2eGoldenBundleSnapshot {
  const transcript = JSON.parse(readFileSync(bundle.transcript_path, "utf8")) as {
    schema_version: string;
    step: string;
    env_flags: E2eEnvFlags;
    exit_code: number;
    stdout_line_count: number;
    stderr_line_count: number;
    diagnostics_emitted: number;
  };
  const stderrTimeline = JSON.parse(readFileSync(bundle.stderr_timeline_path, "utf8")) as
    Array<{ message: string }>;
  const diagnostics = readJsonLines<{
    event: string;
    message: string;
    redaction_count: number;
  }>(bundle.diagnostic_events_path);
  const outputFiles = JSON.parse(readFileSync(bundle.output_files_path, "utf8")) as Array<{
    path: string;
    exists: boolean;
    truncated: boolean;
    redaction_count: number;
  }>;

  return {
    transcript: {
      schema_version: transcript.schema_version,
      step: transcript.step,
      env_flags: transcript.env_flags,
      exit_code: transcript.exit_code,
      stdout_line_count: transcript.stdout_line_count,
      stderr_line_count: transcript.stderr_line_count,
      diagnostics_emitted: transcript.diagnostics_emitted,
    },
    stderr_messages: stderrTimeline.map((entry) => normalizeDynamicText(entry.message)),
    diagnostic_events: diagnostics.map((entry) => {
      if (entry.event === "stdout_line") {
        const lineCount = normalizeDynamicText(entry.message).split("\n").length;
        return {
          event: entry.event,
          message: `<stdout:${lineCount} lines>`,
          redaction_count: entry.redaction_count,
        };
      }
      return {
        event: entry.event,
        message: normalizeDynamicText(entry.message),
        redaction_count: entry.redaction_count,
      };
    }),
    output_files: outputFiles.map((entry) => ({
      path: normalizeDynamicText(entry.path),
      exists: entry.exists,
      truncated: entry.truncated,
      redaction_count: entry.redaction_count,
    })),
  };
}

export function withCwd<T>(cwd: string, fn: () => T): T {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previousCwd);
  }
}

export function createRuntimeCapture(options?: RuntimeCaptureOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const clipboardWrites: string[] = [];
  const pagerInvocations: Array<{ path: string; pager: string }> = [];
  const assertionEvents: E2eAssertionEvent[] = [];
  const diagnosticEvents: E2eDiagnosticEvent[] = [];
  const commandArtifacts: E2eCommandArtifactBundle[] = [];

  const verbosity = options?.verbosity ?? (process.env.CI ? "ci" : "local");
  const envArtifactRoot = process.env.CTX_E2E_ARTIFACT_ROOT?.trim();
  const artifactRoot = resolve(
    options?.artifactRoot ??
      (envArtifactRoot && envArtifactRoot.length > 0
        ? envArtifactRoot
        : mkdtempSync(`${tmpdir()}/ctx-e2e-artifacts-`)),
  );
  mkdirSync(artifactRoot, { recursive: true });
  const captureSessionId = `${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;

  let activeContext: ActiveCommandContext | null = null;
  let runCounter = 0;

  const emitDiagnosticEvent = (
    event: E2eDiagnosticEvent["event"],
    message: string,
  ): void => {
    if (!activeContext) {
      return;
    }
    const redacted = redactText(message, {
      extraPatterns: activeContext.redactionPatterns,
    });
    diagnosticEvents.push({
      schema_version: E2E_LOG_SCHEMA_VERSION,
      channel: "diagnostic",
      event,
      run_id: activeContext.run_id,
      test_case_id: activeContext.test_case_id,
      step: activeContext.step,
      command: activeContext.command,
      cwd: activeContext.cwd,
      env_flags: activeContext.env_flags,
      message: redacted.text,
      redaction_count: redacted.redactionCount,
      timestamp_ms: Date.now(),
    });
  };

  const runtime: CliRuntime = {
    stdout: (message: string) => {
      stdout.push(message);
      emitDiagnosticEvent("stdout_line", message);
    },
    stderr: (message: string) => {
      stderr.push(message);
      emitDiagnosticEvent("stderr_line", message);
    },
    isStdinTty: () => true,
    readStdin: () => "",
    readFile: (path) => readFileSync(path, "utf8"),
    readLink: (path) => readlinkSync(path),
    writeFile: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, "utf8");
    },
    copyToClipboard: (contents) => {
      clipboardWrites.push(contents);
      return { ok: true };
    },
    openInPager: (absolutePath, pagerCommand) => {
      pagerInvocations.push({ path: absolutePath, pager: pagerCommand });
      return { ok: true };
    },
  };

  const writeArtifacts = (
    context: ActiveCommandContext,
    exitCode: number,
    durationMs: number,
  ): E2eCommandArtifactBundle => {
    const bundleDir = resolve(
      artifactRoot,
      sanitizePathSegment(captureSessionId),
      sanitizePathSegment(context.test_case_id),
      sanitizePathSegment(context.run_id),
    );
    mkdirSync(bundleDir, { recursive: true });

    const stdoutSlice = stdout.slice(context.stdoutStartIndex);
    const stderrSlice = stderr.slice(context.stderrStartIndex);
    const clipboardSlice = clipboardWrites.slice(context.clipboardStartIndex);
    const pagerSlice = pagerInvocations.slice(context.pagerStartIndex);
    const diagnosticsSlice = diagnosticEvents.slice(context.diagnosticStartIndex);
    const diagnosticLimit = verbosity === "ci" ? diagnosticsSlice.length : 120;
    const includedDiagnostics = diagnosticsSlice.slice(0, diagnosticLimit);
    const runArtifacts = collectRunArtifactEntries(context.cwd, verbosity);
    const outputFiles = collectOutputFileSnapshots(
      context.argv,
      context.cwd,
      verbosity,
      context.redactionPatterns,
    );

    const stderrTimeline = diagnosticsSlice
      .filter((event) => event.event === "stderr_line")
      .map((event, index) => ({
        sequence: index + 1,
        timestamp_ms: event.timestamp_ms,
        message: event.message,
        redaction_count: event.redaction_count,
      }));

    const transcript = {
      schema_version: E2E_LOG_SCHEMA_VERSION,
      run_id: context.run_id,
      test_case_id: context.test_case_id,
      step: context.step,
      command: context.command,
      argv: [...context.argv],
      cwd: context.cwd,
      env_flags: context.env_flags,
      verbosity,
      started_at_ms: context.startedAtMs,
      duration_ms: durationMs,
      exit_code: exitCode,
      stdout_line_count: stdoutSlice.length,
      stderr_line_count: stderrSlice.length,
      clipboard_write_count: clipboardSlice.length,
      pager_invocation_count: pagerSlice.length,
      diagnostics_emitted: diagnosticsSlice.length,
      diagnostics_truncated: diagnosticsSlice.length > includedDiagnostics.length,
    };

    const transcriptPath = resolve(bundleDir, "command-transcript.json");
    const stderrTimelinePath = resolve(bundleDir, "stderr-timeline.json");
    const outputFilesPath = resolve(bundleDir, "output-files.json");
    const runArtifactsPath = resolve(bundleDir, "run-artifacts-snapshot.json");
    const assertionEventsPath = resolve(bundleDir, "assertion-events.json");
    const diagnosticEventsPath = resolve(bundleDir, "diagnostic-events.jsonl");

    writeJson(transcriptPath, transcript);
    writeJson(stderrTimelinePath, stderrTimeline);
    writeJson(outputFilesPath, outputFiles);
    writeJson(runArtifactsPath, {
      entries: runArtifacts.entries,
      truncated: runArtifacts.truncated,
    });
    writeJson(assertionEventsPath, assertionEvents);
    writeJsonLines(diagnosticEventsPath, includedDiagnostics);

    return {
      run_id: context.run_id,
      test_case_id: context.test_case_id,
      step: context.step,
      bundle_dir: bundleDir,
      transcript_path: transcriptPath,
      stderr_timeline_path: stderrTimelinePath,
      output_files_path: outputFilesPath,
      run_artifacts_path: runArtifactsPath,
      assertion_events_path: assertionEventsPath,
      diagnostic_events_path: diagnosticEventsPath,
      verbosity,
    };
  };

  const runCommand = (input: E2eCommandInput): number => {
    runCounter += 1;
    const sequence = String(runCounter).padStart(3, "0");
    const { envFlags, redactionPatterns } = parseEnvFlags(input.argv);
    const commandText = redactText(formatCommand(input.argv), {
      extraPatterns: redactionPatterns,
    }).text;

    activeContext = {
      schema_version: E2E_LOG_SCHEMA_VERSION,
      run_id: `${input.testCaseId}-${sequence}`,
      test_case_id: input.testCaseId,
      step: input.step,
      command: commandText,
      argv: [...input.argv],
      cwd: process.cwd(),
      env_flags: envFlags,
      startedAtMs: Date.now(),
      stdoutStartIndex: stdout.length,
      stderrStartIndex: stderr.length,
      clipboardStartIndex: clipboardWrites.length,
      pagerStartIndex: pagerInvocations.length,
      diagnosticStartIndex: diagnosticEvents.length,
      redactionPatterns,
    };

    let exitCode = -1;
    try {
      exitCode = run(input.argv, runtime);
      return exitCode;
    } finally {
      if (activeContext) {
        const durationMs = Math.max(0, Date.now() - activeContext.startedAtMs);
        assertionEvents.push({
          schema_version: E2E_LOG_SCHEMA_VERSION,
          channel: "assertion",
          event: "command_result",
          run_id: activeContext.run_id,
          test_case_id: activeContext.test_case_id,
          step: activeContext.step,
          command: activeContext.command,
          cwd: activeContext.cwd,
          env_flags: activeContext.env_flags,
          duration_ms: durationMs,
          exit_code: exitCode,
          stdout_line_count: stdout.length - activeContext.stdoutStartIndex,
          stderr_line_count: stderr.length - activeContext.stderrStartIndex,
        });
        commandArtifacts.push(writeArtifacts(activeContext, exitCode, durationMs));
      }
      activeContext = null;
    }
  };

  return {
    runtime,
    runCommand,
    stdout,
    stderr,
    clipboardWrites,
    pagerInvocations,
    assertionEvents,
    diagnosticEvents,
    artifactRoot,
    verbosity,
    commandArtifacts,
  };
}
