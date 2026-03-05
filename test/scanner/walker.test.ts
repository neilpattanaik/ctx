import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { walkRepositoryFiles } from "../../src/scanner/walker";

describe("walkRepositoryFiles", () => {
  const repoRoot = resolve("test/fixtures/scanner/walker/repo");

  test("applies scanner filters in one pass with deterministic output", async () => {
    const result = await walkRepositoryFiles({
      repoRoot,
      maxFileBytes: 40,
      useGitignore: true,
      extraIgnorePatterns: ["config-ignore/**"],
      includeGlobs: ["include/**"],
      neverIncludeGlobs: ["never/**"],
      excludeGlobs: ["exclude/**"],
      skipBinary: true,
      resolveGlobalGitignorePath: () => null,
    });

    expect(result.files.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "docs/file.custom",
      "include/large-include.txt",
      "notes/readme.md",
      "src/app.ts",
    ]);
    expect(result.files.map((entry) => entry.language)).toEqual([
      "text",
      "text",
      "text",
      "markdown",
      "typescript",
    ]);
    expect(result.files.every((entry) => entry.hash === "")).toBe(true);
    expect(result.files.every((entry) => entry.isText)).toBe(true);

    expect(result.oversized).toEqual([
      {
        path: "large.txt",
        size: 52,
        reason: "exceeds max_file_bytes",
      },
    ]);
    expect(result.excluded).toEqual([
      {
        path: "assets/logo.png",
        reason: "binary",
      },
      {
        path: "large.txt",
        size: 52,
        reason: "exceeds max_file_bytes",
      },
      {
        path: "never/secret.ts",
        reason: "never-include",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("never-include cannot be overridden by include and bypasses binary sniffing", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-never-include-`);
    await writeFile(resolve(tempRepo, "visible.ts"), "export const visible = true;\n");
    await writeFile(resolve(tempRepo, "api-secret.txt"), "TOKEN=abc123\n");

    let readChunkCalls = 0;
    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      useGitignore: false,
      includeGlobs: ["api-secret.txt"],
      neverIncludeGlobs: ["**/*secret*"],
      skipBinary: true,
      readBinaryChunk: () => {
        readChunkCalls += 1;
        return new Uint8Array([65, 66, 67]);
      },
    });

    expect(result.files.map((entry) => entry.path)).toEqual(["visible.ts"]);
    expect(result.excluded).toContainEqual({
      path: "api-secret.txt",
      reason: "never-include",
    });
    expect(readChunkCalls).toBe(1);
  });

  test("records warning and continues when binary sniffing fails", async () => {
    const result = await walkRepositoryFiles({
      repoRoot,
      maxFileBytes: 500,
      useGitignore: true,
      skipBinary: true,
      resolveGlobalGitignorePath: () => null,
      readBinaryChunk: (pathValue) => {
        if (pathValue.endsWith("docs/file.custom")) {
          throw new Error("EACCES");
        }
        return new Uint8Array([65, 66, 67]);
      },
    });

    expect(result.files.some((entry) => entry.path === "docs/file.custom")).toBe(false);
    expect(result.warnings).toEqual([
      {
        path: "docs/file.custom",
        reason: "binary_check_failed",
        message: "EACCES",
      },
    ]);
  });

  test("treats null-byte text as binary and does not allow force-include override", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-null-byte-`);
    await writeFile(resolve(tempRepo, "normal.ts"), "export const ok = true;\n");
    await writeFile(resolve(tempRepo, "null-byte.txt"), "placeholder\n");

    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      includeGlobs: ["null-byte.txt"],
      skipBinary: true,
      useGitignore: false,
      readBinaryChunk: (pathValue) => {
        if (pathValue.endsWith("null-byte.txt")) {
          return new Uint8Array([65, 0, 66]);
        }
        return new Uint8Array([65, 66, 67]);
      },
    });

    expect(result.files.map((entry) => entry.path)).toEqual(["normal.ts"]);
    expect(result.excluded).toContainEqual({
      path: "null-byte.txt",
      reason: "binary",
    });
  });

  test("enforces exact 1,500,000 byte boundary and include override for oversized text", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-size-boundary-`);
    await writeFile(resolve(tempRepo, "exact.txt"), Buffer.alloc(1_500_000, 65));
    await writeFile(resolve(tempRepo, "over.txt"), Buffer.alloc(1_500_001, 65));
    await writeFile(resolve(tempRepo, "forced.txt"), Buffer.alloc(1_500_001, 65));

    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      includeGlobs: ["forced.txt"],
      skipBinary: true,
      useGitignore: false,
    });

    expect(result.files.map((entry) => entry.path)).toEqual([
      "exact.txt",
      "forced.txt",
    ]);
    expect(result.oversized).toEqual([
      {
        path: "over.txt",
        size: 1_500_001,
        reason: "exceeds max_file_bytes",
      },
    ]);
    expect(result.excluded).toContainEqual({
      path: "over.txt",
      size: 1_500_001,
      reason: "exceeds max_file_bytes",
    });
  });

  test("filters extension-identified binaries early without content sniffing", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-many-binary-`);
    await mkdir(resolve(tempRepo, "bin"), { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      await writeFile(resolve(tempRepo, "bin", `file-${index}.png`), "png");
    }

    let readChunkCalls = 0;
    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      skipBinary: true,
      useGitignore: false,
      readBinaryChunk: () => {
        readChunkCalls += 1;
        return new Uint8Array([65, 66, 67]);
      },
    });

    expect(result.files).toEqual([]);
    expect(result.oversized).toEqual([]);
    expect(result.excluded.length).toBe(200);
    expect(result.excluded.every((entry) => entry.reason === "binary")).toBe(true);
    expect(readChunkCalls).toBe(0);
  });

  test("continues scanning when nested gitignore discovery hits an unreadable directory", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-gitignore-unreadable-`);
    await mkdir(resolve(tempRepo, "src"), { recursive: true });
    await writeFile(resolve(tempRepo, "src", "keep.ts"), "export const keep = true;\n");
    const blockedDir = resolve(tempRepo, "blocked");
    await mkdir(blockedDir, { recursive: true });
    await writeFile(resolve(blockedDir, ".gitignore"), "*.ts\n");
    await chmod(blockedDir, 0o000);

    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      useGitignore: true,
      skipBinary: true,
      resolveGlobalGitignorePath: () => null,
    });

    expect(result.files.map((entry) => entry.path)).toEqual(["src/keep.ts"]);
    expect(result.warnings).toEqual([
      {
        path: "blocked",
        reason: "readdir_failed",
        message: expect.any(String),
      },
    ]);
  });

  test("does not follow or index symlink entries", async () => {
    const tempRepo = await mkdtemp(`${tmpdir()}/ctx-walker-symlink-`);
    await mkdir(resolve(tempRepo, "src"), { recursive: true });
    await mkdir(resolve(tempRepo, "linked-dir-target"), { recursive: true });
    await writeFile(resolve(tempRepo, "src", "keep.ts"), "export const keep = true;\n");
    await writeFile(resolve(tempRepo, "linked-dir-target", "hidden.ts"), "export const hidden = true;\n");
    await writeFile(resolve(tempRepo, "linked-file-target.ts"), "export const target = true;\n");

    try {
      await symlink(
        resolve(tempRepo, "linked-dir-target"),
        resolve(tempRepo, "linked-dir"),
        "dir",
      );
      await symlink(
        resolve(tempRepo, "linked-file-target.ts"),
        resolve(tempRepo, "linked-file.ts"),
        "file",
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code &&
        ["EPERM", "EACCES", "EOPNOTSUPP", "ENOTSUP"].includes(
          (error as { code?: string }).code as string,
        )
      ) {
        return;
      }
      throw error;
    }

    const result = await walkRepositoryFiles({
      repoRoot: tempRepo,
      maxFileBytes: 1_500_000,
      useGitignore: false,
      skipBinary: true,
    });

    expect(result.files.map((entry) => entry.path)).toEqual([
      "linked-dir-target/hidden.ts",
      "linked-file-target.ts",
      "src/keep.ts",
    ]);
    expect(result.files.some((entry) => entry.path === "linked-dir/hidden.ts")).toBe(false);
    expect(result.files.some((entry) => entry.path === "linked-file.ts")).toBe(false);
  });
});
