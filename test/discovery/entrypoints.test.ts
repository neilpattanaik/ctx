import { describe, expect, test } from "bun:test";
import { detectLikelyEntrypoints } from "../../src/discovery/entrypoints";

function byPath(
  result: ReturnType<typeof detectLikelyEntrypoints>,
  path: string,
): (typeof result)[number] | undefined {
  return result.find((entry) => entry.path === path);
}

describe("detectLikelyEntrypoints", () => {
  test("detects package.json main/bin/exports targets and framework roots", () => {
    const files = [
      "package.json",
      "src/server.ts",
      "src/cli.ts",
      "src/index.ts",
      "src/feature/worker.ts",
    ];

    const readFileText = (path: string): string | undefined => {
      if (path !== "package.json") {
        return undefined;
      }
      return JSON.stringify({
        main: "./src/server.ts",
        bin: {
          ctx: "./src/cli.ts",
        },
        exports: {
          ".": "./src/index.ts",
        },
      });
    };

    const result = detectLikelyEntrypoints(files, { readFileText });
    expect(result.length).toBeGreaterThan(0);

    const server = byPath(result, "src/server.ts");
    const cli = byPath(result, "src/cli.ts");
    const index = byPath(result, "src/index.ts");
    expect(server?.heuristics.map((item) => item.heuristic)).toContain(
      "package_main",
    );
    expect(cli?.heuristics.map((item) => item.heuristic)).toContain("package_bin");
    expect(index?.heuristics.map((item) => item.heuristic)).toContain(
      "package_exports",
    );
    expect(server?.heuristics.map((item) => item.heuristic)).toContain(
      "framework_root_entry",
    );
  });

  test("detects route/controller, test config, config, and language-specific entrypoints", () => {
    const files = [
      "src/routes/users.ts",
      "src/controllers/auth.ts",
      "jest.config.ts",
      "config/settings.ts",
      ".env.example",
      "setup.py",
      "cmd/tool/main.go",
      "src/main.rs",
      "docs/readme.md",
    ];

    const result = detectLikelyEntrypoints(files);
    expect(byPath(result, "src/routes/users.ts")?.heuristics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heuristic: "route_controller" }),
      ]),
    );
    expect(byPath(result, "src/controllers/auth.ts")?.heuristics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heuristic: "route_controller" }),
      ]),
    );
    expect(byPath(result, "jest.config.ts")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "test_config" })]),
    );
    expect(byPath(result, "config/settings.ts")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "config_entry" })]),
    );
    expect(byPath(result, ".env.example")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "config_entry" })]),
    );
    expect(byPath(result, "setup.py")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "python_entry" })]),
    );
    expect(byPath(result, "cmd/tool/main.go")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "go_entry" })]),
    );
    expect(byPath(result, "src/main.rs")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "rust_entry" })]),
    );
    expect(byPath(result, "docs/readme.md")).toBeUndefined();
  });

  test("detects shebang-based CLI entrypoints and bin directory hints", () => {
    const files = ["scripts/deploy", "bin/ctx.js", "src/app.ts"];
    const readFileText = (path: string): string | undefined => {
      if (path === "scripts/deploy") {
        return "#!/usr/bin/env bash\necho deploy";
      }
      if (path === "bin/ctx.js") {
        return "console.log('ctx')";
      }
      return undefined;
    };

    const result = detectLikelyEntrypoints(files, { readFileText });
    expect(byPath(result, "scripts/deploy")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "cli_shebang" })]),
    );
    expect(byPath(result, "bin/ctx.js")?.heuristics).toEqual(
      expect.arrayContaining([expect.objectContaining({ heuristic: "cli_bin_dir" })]),
    );
  });

  test("sorts deterministically and honors maxResults", () => {
    const files = ["src/controllers/zeta.ts", "src/controllers/alpha.ts"];
    const result = detectLikelyEntrypoints(files, { maxResults: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("src/controllers/alpha.ts");
  });
});
