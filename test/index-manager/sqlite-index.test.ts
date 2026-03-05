import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  INDEX_SCHEMA_VERSION,
  openSqliteIndex,
  openSqliteIndexIfEnabled,
  resolveIndexDatabasePath,
} from "../../src/index-manager";

describe("sqlite index utilities", () => {
  test("resolves default repo-local index path", () => {
    const pathValue = resolveIndexDatabasePath({ repoRoot: "/repo/work" });
    expect(pathValue).toBe(resolve("/repo/work/.ctx/index.db"));
  });

  test("resolves relative and absolute cacheDir variants", () => {
    const relativePath = resolveIndexDatabasePath({
      repoRoot: "/repo/work",
      cacheDir: ".cache/ctx",
    });
    const absoluteDirPath = resolveIndexDatabasePath({
      repoRoot: "/repo/work",
      cacheDir: "/var/tmp/ctx-cache",
    });
    const absoluteFilePath = resolveIndexDatabasePath({
      repoRoot: "/repo/work",
      cacheDir: "/var/tmp/ctx-cache/custom.sqlite",
    });

    expect(relativePath).toBe(resolve("/repo/work/.cache/ctx/index.db"));
    expect(absoluteDirPath).toBe(resolve("/var/tmp/ctx-cache/index.db"));
    expect(absoluteFilePath).toBe(resolve("/var/tmp/ctx-cache/custom.sqlite"));
  });

  test("opens sqlite index, initializes schema, and creates the database file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-index-"));
    const dbPath = resolve(tempDir, "cache", "index.db");

    const handle = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
    });

    expect(handle.schema.currentVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(existsSync(dbPath)).toBe(true);
    expect(handle.journalMode.toLowerCase()).toBe("wal");
    handle.close();
  });

  test("supports in-memory sqlite index initialization", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    const row =
      handle.db
        .query<{ value: string }>(
          `SELECT value FROM schema_meta WHERE key = 'schema_version';`,
        )
        .get()?.value ?? "";

    expect(row).toBe(INDEX_SCHEMA_VERSION);
    handle.close();
  });

  test("returns null and avoids db creation when index is disabled", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-index-off-"));
    const dbPath = resolve(tempDir, "cache", "index.db");

    const handle = openSqliteIndexIfEnabled({
      enabled: false,
      dbPath,
      rebuildOnSchemaChange: true,
    });

    expect(handle).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
  });
});
