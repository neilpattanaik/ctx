import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../../src/index";
import type { CliRuntime } from "../../src/cli";

interface GoldenCase {
  id: string;
  argv: string[];
  snapshotPath: string;
}

interface GoldenOutput {
  argv: string[];
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

const FIXTURE_REPO = "test/fixtures/golden-repo";

function normalizeGoldenText(value: string): string {
  return value
    .replace(/(\brun_id:\s*)[^\n]+/g, "$1<run-id>")
    .replace(/"run_id":"[^"]+"/g, '"run_id":"<run-id>"')
    .replace(/\b\d{8}T\d{6}-[0-9a-f]{8}\b/g, "<run-id>");
}

function normalizeGoldenOutput(output: GoldenOutput): GoldenOutput {
  return {
    ...output,
    stdout: output.stdout.map((line) => normalizeGoldenText(line)),
    stderr: output.stderr.map((line) => normalizeGoldenText(line)),
  };
}

const GOLDEN_CASES: GoldenCase[] = [
  {
    id: "simple-task",
    argv: [
      "Investigate fixture auth flow",
      "--repo",
      FIXTURE_REPO,
      "--git-status",
      "off",
    ],
    snapshotPath: "test/fixtures/golden-snapshots/snapshot-a-simple.json",
  },
  {
    id: "degraded-budget",
    argv: [
      "Investigate fixture auth flow",
      "--budget",
      "1200",
      "--repo",
      FIXTURE_REPO,
      "--git-status",
      "off",
    ],
    snapshotPath: "test/fixtures/golden-snapshots/snapshot-b-budget.json",
  },
  {
    id: "review-with-diff",
    argv: [
      "Investigate fixture auth flow",
      "--mode",
      "review",
      "--diff",
      "off",
      "--repo",
      FIXTURE_REPO,
      "--git-status",
      "off",
    ],
    snapshotPath: "test/fixtures/golden-snapshots/snapshot-c-review-diff.json",
  },
  {
    id: "question-mode",
    argv: [
      "Explain auth entrypoint",
      "--mode",
      "question",
      "--repo",
      FIXTURE_REPO,
      "--git-status",
      "off",
    ],
    snapshotPath: "test/fixtures/golden-snapshots/snapshot-d-question.json",
  },
  {
    id: "context-mode",
    argv: [
      "Context package for auth",
      "--mode",
      "context",
      "--repo",
      FIXTURE_REPO,
      "--git-status",
      "off",
    ],
    snapshotPath: "test/fixtures/golden-snapshots/snapshot-e-context.json",
  },
];

function createGoldenRuntimeCapture(): {
  runtime: CliRuntime;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: CliRuntime = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    isStdinTty: () => true,
    readStdin: () => "",
    readFile: (path) => {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    },
    readLink: (path) => {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    },
    writeFile: () => undefined,
    copyToClipboard: () => ({ ok: true }),
    openInPager: () => ({ ok: true }),
  };
  return { runtime, stdout, stderr };
}

function executeCase(argv: string[]): GoldenOutput {
  const capture = createGoldenRuntimeCapture();
  const exitCode = run(argv, capture.runtime);
  return normalizeGoldenOutput({
    argv: [...argv],
    exitCode,
    stdout: capture.stdout,
    stderr: capture.stderr,
  });
}

function loadGoldenSnapshot(pathValue: string): GoldenOutput {
  const absolutePath = resolve(process.cwd(), pathValue);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as GoldenOutput;
  return normalizeGoldenOutput(parsed);
}

describe("golden prompt snapshots", () => {
  for (const goldenCase of GOLDEN_CASES) {
    test(`matches snapshot for ${goldenCase.id}`, () => {
      const firstRun = executeCase(goldenCase.argv);
      const secondRun = executeCase(goldenCase.argv);
      expect(secondRun).toEqual(firstRun);

      const snapshot = loadGoldenSnapshot(goldenCase.snapshotPath);
      expect(firstRun).toEqual(snapshot);
    });
  }
});
