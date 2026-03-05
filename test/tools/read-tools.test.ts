import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ReadToolError,
  executeReadFile,
  executeReadSnippet,
  validateReadFileArgs,
  validateReadSnippetArgs,
  type ReadToolsContext,
} from "../../src/tools/read-tools";

async function createRepoFixture(): Promise<string> {
  return mkdtemp(`${tmpdir()}/ctx-read-tools-`);
}

function baseContext(repoRoot: string): ReadToolsContext {
  return {
    repoRoot,
    repoConfig: {
      maxFileBytes: 1_500_000,
    },
    privacyMode: "normal",
    neverIncludeGlobs: [],
    lineNumbers: true,
  };
}

describe("read tool arg validators", () => {
  test("validates read_file args", () => {
    expect(validateReadFileArgs({ path: "src/app.ts" })).toEqual({ ok: true });
    expect(validateReadFileArgs({ path: "src/app.ts", start_line: 1, limit: 10 })).toEqual({
      ok: true,
    });
    expect(validateReadFileArgs({ path: "" })).toEqual({
      ok: false,
      message: "args.path must be a non-empty string",
    });
    expect(validateReadFileArgs({ path: "a.ts", start_line: 0 })).toEqual({
      ok: false,
      message: "args.start_line must be a positive integer",
    });
    expect(validateReadFileArgs({ path: "a.ts", limit: -1 })).toEqual({
      ok: false,
      message: "args.limit must be a positive integer",
    });
  });

  test("validates read_snippet args", () => {
    expect(validateReadSnippetArgs({ path: "src/app.ts", anchor: 10 })).toEqual({
      ok: true,
    });
    expect(validateReadSnippetArgs({ path: "src/app.ts", anchor: "token", before: 0, after: 4 })).toEqual({
      ok: true,
    });
    expect(validateReadSnippetArgs({ path: "src/app.ts", anchor: "" })).toEqual({
      ok: false,
      message: "args.anchor must be a positive integer line number or non-empty string",
    });
    expect(validateReadSnippetArgs({ path: "src/app.ts", anchor: 2, before: -1 })).toEqual({
      ok: false,
      message: "args.before must be a non-negative integer",
    });
  });
});

describe("executeReadFile", () => {
  test("reads with start_line and limit using deterministic line numbering", async () => {
    const repoRoot = await createRepoFixture();
    await mkdir(resolve(repoRoot, "src"), { recursive: true });
    await writeFile(resolve(repoRoot, "src/app.ts"), "alpha\nbeta\ngamma\n", "utf8");

    const result = await executeReadFile(
      {
        path: "src/app.ts",
        start_line: 2,
        limit: 1,
      },
      baseContext(repoRoot),
    );

    expect(result.path).toBe("src/app.ts");
    expect(result.content).toBe("0002| beta\n... ‹TRUNCATED: limit=1›\n");
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.returned_line_count).toBe(1);
  });

  test("applies strict privacy max line cap of 20", async () => {
    const repoRoot = await createRepoFixture();
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
    await writeFile(resolve(repoRoot, "long.txt"), `${lines.join("\n")}\n`, "utf8");

    const result = await executeReadFile(
      { path: "long.txt" },
      {
        ...baseContext(repoRoot),
        privacyMode: "strict",
      },
    );

    expect(result.truncation?.limit).toBe(20);
    expect(result.truncation?.returned_line_count).toBe(20);
    expect(result.truncation?.truncated).toBe(true);
  });

  test("denies path traversal and never-include matches", async () => {
    const repoRoot = await createRepoFixture();
    await writeFile(resolve(repoRoot, "secret.txt"), "top-secret", "utf8");

    await expect(
      executeReadFile(
        { path: "../outside.txt" },
        baseContext(repoRoot),
      ),
    ).rejects.toMatchObject({
      code: "READ_DENIED",
    } satisfies Partial<ReadToolError>);

    await expect(
      executeReadFile(
        { path: "secret.txt" },
        {
          ...baseContext(repoRoot),
          neverIncludeGlobs: ["**/*secret*"],
        },
      ),
    ).rejects.toMatchObject({
      code: "READ_DENIED",
    } satisfies Partial<ReadToolError>);
  });

  test("rejects binary and oversized files with explicit error codes", async () => {
    const repoRoot = await createRepoFixture();
    await writeFile(resolve(repoRoot, "image.png"), "not-really-png", "utf8");
    await writeFile(resolve(repoRoot, "big.txt"), "1234567890", "utf8");

    await expect(
      executeReadFile(
        { path: "image.png" },
        baseContext(repoRoot),
      ),
    ).rejects.toMatchObject({
      code: "BINARY_FILE",
    } satisfies Partial<ReadToolError>);

    await expect(
      executeReadFile(
        { path: "big.txt" },
        {
          ...baseContext(repoRoot),
          repoConfig: { maxFileBytes: 5 },
        },
      ),
    ).rejects.toMatchObject({
      code: "SIZE_EXCEEDED",
    } satisfies Partial<ReadToolError>);
  });
});

describe("executeReadSnippet", () => {
  test("reads snippet around numeric anchor", async () => {
    const repoRoot = await createRepoFixture();
    const lines = ["one", "two", "three", "four", "five", "six"];
    await writeFile(resolve(repoRoot, "file.txt"), `${lines.join("\n")}\n`, "utf8");

    const result = await executeReadSnippet(
      {
        path: "file.txt",
        anchor: 3,
        before: 1,
        after: 2,
      },
      baseContext(repoRoot),
    );

    expect(result.anchor_line).toBe(3);
    expect(result.start_line).toBe(2);
    expect(result.content).toBe("0002| two\n0003| three\n0004| four\n0005| five\n");
  });

  test("resolves string anchor to first match and errors when missing", async () => {
    const repoRoot = await createRepoFixture();
    await writeFile(resolve(repoRoot, "file.txt"), "alpha\nneedle\nneedle-again\n", "utf8");

    const found = await executeReadSnippet(
      {
        path: "file.txt",
        anchor: "needle",
        before: 0,
        after: 0,
      },
      baseContext(repoRoot),
    );
    expect(found.anchor_line).toBe(2);
    expect(found.content).toBe("0002| needle\n");

    await expect(
      executeReadSnippet(
        {
          path: "file.txt",
          anchor: "missing-anchor",
        },
        baseContext(repoRoot),
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    } satisfies Partial<ReadToolError>);
  });
});
