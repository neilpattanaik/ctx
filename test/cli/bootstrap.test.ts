import { describe, expect, test } from "bun:test";
import { run } from "../../src/index";

describe("ctx bootstrap", () => {
  test("returns success for help flag", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = run(["--help"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("ctx - deterministic context builder");
    expect(stderr).toEqual([]);
  });
});
