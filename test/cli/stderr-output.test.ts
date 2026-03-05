import { describe, expect, test } from "bun:test";
import { CliStderrReporter } from "../../src/cli/stderr-output";
import type { CliOptions } from "../../src/cli/parse-args";

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    copy: false,
    quiet: false,
    verbose: false,
    jsonSummary: false,
    failOnOverbudget: false,
    noLlm: false,
    dryRun: false,
    noIndex: false,
    include: [],
    exclude: [],
    preferFull: [],
    preferSlices: [],
    preferCodemap: [],
    entrypoint: [],
    redactPattern: [],
    neverInclude: [],
    rebuild: false,
    help: false,
    ...overrides,
  };
}

describe("CliStderrReporter", () => {
  test("emits deterministic progress and warning lines", () => {
    const stderr: string[] = [];
    const reporter = new CliStderrReporter(createOptions(), {
      stderr: (line) => stderr.push(line),
    });

    reporter.scanningRepository();
    reporter.updatingIndex();
    reporter.discoveryBackend(createOptions({ discover: "llm", model: "gpt-4o" }));
    reporter.discoveryTurn(2, 6);
    reporter.assemblingPrompt();
    reporter.tokenSummary({
      budget: 60_000,
      estimated: 45_230,
      fullFiles: 8,
      sliceFiles: 15,
      codemapFiles: 19,
    });
    reporter.warnNoApiKeyFallback();
    reporter.warnOversizedFiles(3);
    reporter.warnBudgetDegradations(4);
    reporter.warnRedactedSecrets(2);

    expect(stderr).toEqual([
      "Scanning repository...",
      "Updating index...",
      "Discovery: using llm (gpt-4o)",
      "Discovery: turn 2/6...",
      "Assembling prompt...",
      "Budget: 60000 | Estimated: 45230 | Files: 42 (8 full, 15 slices, 19 codemap)",
      "Warning: no API key configured, using offline discovery",
      "Warning: 3 files exceeded size limit",
      "Warning: budget exceeded, applied 4 degradations",
      "Warning: redacted 2 secrets",
    ]);
  });

  test("suppresses all output when quiet mode is enabled", () => {
    const stderr: string[] = [];
    const reporter = new CliStderrReporter(createOptions({ quiet: true }), {
      stderr: (line) => stderr.push(line),
    });

    reporter.scanningRepository();
    reporter.warnRedactedSecrets(5);
    reporter.tokenSummary({
      budget: 1000,
      estimated: 500,
      fullFiles: 1,
      sliceFiles: 0,
      codemapFiles: 0,
    });

    expect(stderr).toEqual([]);
  });

  test("includes timing suffix in verbose mode", () => {
    const stderr: string[] = [];
    const reporter = new CliStderrReporter(createOptions({ verbose: true }), {
      stderr: (line) => stderr.push(line),
    });

    reporter.scanningRepository(12.8);
    reporter.discoveryTurn(1, 4, 2.3);

    expect(stderr).toEqual([
      "Scanning repository... (12ms)",
      "Discovery: turn 1/4... (2ms)",
    ]);
  });
});
