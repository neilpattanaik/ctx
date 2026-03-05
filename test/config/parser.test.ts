import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  parseRepoConfigFile,
  parseTomlConfigFile,
} from "../../src/config/parser";

function writeTempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-config-"));
  const filePath = join(dir, "config.toml");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("config TOML parser", () => {
  test("returns null when file does not exist", () => {
    const missingPath = join(tmpdir(), "ctx-config-missing", "config.toml");
    const result = parseTomlConfigFile(missingPath);

    expect(result.config).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test("returns empty partial config for empty file", () => {
    const filePath = writeTempConfig("");
    const result = parseTomlConfigFile(filePath);

    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  test("parses valid TOML into normalized camelCase config fields", () => {
    const filePath = writeTempConfig(`
[defaults]
mode = "review"
budget_tokens = 12345
line_numbers = false

[repo]
root = "./repo"
ignore = ["dist/**"]

[output]
path_display = "absolute"
`);

    const result = parseTomlConfigFile(filePath);
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual({
      defaults: {
        mode: "review",
        budgetTokens: 12345,
        lineNumbers: false,
      },
      repo: {
        root: "./repo",
        ignore: ["dist/**"],
      },
      output: {
        pathDisplay: "absolute",
      },
    });
  });

  test("warns and ignores unknown sections and keys", () => {
    const filePath = writeTempConfig(`
[defaults]
mode = "plan"
unknown_key = true

[mystery]
foo = "bar"
`);

    const result = parseTomlConfigFile(filePath);
    expect(result.config).toEqual({
      defaults: {
        mode: "plan",
      },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unknown_key",
      "unknown_section",
    ]);
  });

  test("warns on invalid values and keeps valid siblings", () => {
    const filePath = writeTempConfig(`
[git]
max_files = "bad"
git_status = true
`);

    const result = parseTomlConfigFile(filePath);
    expect(result.config).toEqual({
      git: {
        gitStatus: true,
      },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "invalid_value",
    ]);
    expect(result.warnings[0]?.keyPath).toBe("git.max_files");
  });

  test("returns parse warning for invalid TOML syntax", () => {
    const filePath = writeTempConfig(`
[defaults
mode = "plan"
`);

    const result = parseTomlConfigFile(filePath);
    expect(result.config).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("parse_error");
  });

  test("loads repo-local .ctx/config.toml path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ctx-repo-"));
    mkdirSync(join(repoRoot, ".ctx"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".ctx", "config.toml"),
      "[defaults]\nmode = \"question\"\n",
      "utf8",
    );

    const result = parseRepoConfigFile(repoRoot);
    expect(result.config).toEqual({
      defaults: {
        mode: "question",
      },
    });
    expect(result.warnings).toEqual([]);
  });
});
