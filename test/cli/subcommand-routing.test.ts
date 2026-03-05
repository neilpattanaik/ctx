import { describe, expect, test } from "bun:test";

import { run } from "../../src/index";

function createRuntimeCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    runtime: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

describe("CLI subcommand routing", () => {
  test("routes main command with task text", () => {
    const capture = createRuntimeCapture();
    const exitCode = run(["Investigate", "500s"], capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout).toEqual([
      "main pipeline handler pending: Investigate 500s",
    ]);
    expect(capture.stderr).toEqual([]);
  });

  test("returns usage error for main command without task text", () => {
    const capture = createRuntimeCapture();
    const exitCode = run([], capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr).toEqual([
      "No TASK_TEXT provided. Pass task text or use --help.",
    ]);
  });

  test("routes each subcommand to its handler", () => {
    const initCapture = createRuntimeCapture();
    expect(run(["init"], initCapture.runtime)).toBe(0);
    expect(initCapture.stdout[0]).toBe("init handler pending");

    const agentsCapture = createRuntimeCapture();
    expect(run(["agents"], agentsCapture.runtime)).toBe(0);
    expect(agentsCapture.stdout[0]).toBe("agents handler pending");

    const indexCapture = createRuntimeCapture();
    expect(run(["index", "--rebuild"], indexCapture.runtime)).toBe(0);
    expect(indexCapture.stdout[0]).toBe("index rebuild handler pending");

    const templatesCapture = createRuntimeCapture();
    expect(run(["templates", "show", "plan"], templatesCapture.runtime)).toBe(0);
    expect(templatesCapture.stdout[0]).toBe("templates show handler pending: plan");

    const explainCapture = createRuntimeCapture();
    expect(run(["explain", "last"], explainCapture.runtime)).toBe(0);
    expect(explainCapture.stdout[0]).toBe("explain handler pending: last");

    const manifestCapture = createRuntimeCapture();
    expect(run(["manifest", "run-123"], manifestCapture.runtime)).toBe(0);
    expect(manifestCapture.stdout[0]).toBe("manifest handler pending: run-123");

    const openCapture = createRuntimeCapture();
    expect(run(["open", "last"], openCapture.runtime)).toBe(0);
    expect(openCapture.stdout[0]).toBe("open handler pending: last");
  });
});
