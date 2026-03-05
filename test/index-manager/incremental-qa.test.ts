import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { FileEntry } from "../../src/types";
import {
  applyIncrementalIndexUpdate,
  indexFileMetadataBatch,
  initializeIndexSchema,
  openSqliteIndex,
  openSqliteIndexIfEnabled,
} from "../../src/index-manager";

function makeEntry(index: number, overrides?: Partial<FileEntry>): FileEntry {
  const path = `src/file-${index.toString().padStart(4, "0")}.ts`;
  return {
    path,
    size: 100 + index,
    mtime: 1000 + index,
    hash: `hash-${index}`,
    language: "typescript",
    isText: true,
    ...overrides,
  };
}

describe("incremental indexing QA matrix", () => {
  test("covers first index, one-file content change, add, delete, no-change, and mtime-only change", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    const initial = Array.from({ length: 10 }, (_, index) => makeEntry(index + 1));
    const first = indexFileMetadataBatch(handle.db, initial, {
      nowIso: () => "2026-03-05T00:00:00.000Z",
    });
    expect(first.upsertedCount).toBe(10);

    const changedContent = initial.map((entry) =>
      entry.path === "src/file-0004.ts"
        ? { ...entry, mtime: entry.mtime + 10, hash: "hash-4-updated", size: entry.size + 5 }
        : entry,
    );
    const changeResult = applyIncrementalIndexUpdate(handle.db, changedContent, {
      nowIso: () => "2026-03-05T00:05:00.000Z",
    });
    expect(changeResult).toEqual({
      upsertedCount: 1,
      touchedCount: 0,
      deletedCount: 0,
      unchangedCount: 9,
      indexedAt: "2026-03-05T00:05:00.000Z",
    });

    const withAdded = [...changedContent, makeEntry(11)];
    const addResult = applyIncrementalIndexUpdate(handle.db, withAdded, {
      nowIso: () => "2026-03-05T00:10:00.000Z",
    });
    expect(addResult.upsertedCount).toBe(1);
    expect(addResult.unchangedCount).toBe(10);

    const withDeleted = withAdded.filter((entry) => entry.path !== "src/file-0008.ts");
    const deleteResult = applyIncrementalIndexUpdate(handle.db, withDeleted, {
      nowIso: () => "2026-03-05T00:15:00.000Z",
    });
    expect(deleteResult.deletedCount).toBe(1);

    const noChangeResult = applyIncrementalIndexUpdate(handle.db, withDeleted, {
      nowIso: () => "2026-03-05T00:20:00.000Z",
    });
    expect(noChangeResult).toEqual({
      upsertedCount: 0,
      touchedCount: 0,
      deletedCount: 0,
      unchangedCount: withDeleted.length,
      indexedAt: "2026-03-05T00:20:00.000Z",
    });

    const mtimeOnly = withDeleted.map((entry) =>
      entry.path === "src/file-0005.ts"
        ? { ...entry, mtime: entry.mtime + 100, hash: entry.hash }
        : entry,
    );
    const mtimeOnlyResult = applyIncrementalIndexUpdate(handle.db, mtimeOnly, {
      nowIso: () => "2026-03-05T00:25:00.000Z",
    });
    expect(mtimeOnlyResult.upsertedCount).toBe(0);
    expect(mtimeOnlyResult.touchedCount).toBe(1);
    expect(mtimeOnlyResult.unchangedCount).toBe(withDeleted.length - 1);
    handle.close();
  });

  test("triggers schema rebuild on version mismatch and rebuild flag", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-index-rebuild-"));
    const dbPath = resolve(tempDir, "index.db");

    const firstHandle = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
    });
    firstHandle.close();

    const raw = new Database(dbPath);
    raw.query(`UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version';`).run("0");
    raw.close();

    const rebuilt = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
    });
    expect(rebuilt.schema.rebuilt).toBe(true);
    expect(rebuilt.schema.previousVersion).toBe("0");
    rebuilt.close();
  });

  test("uses WAL mode and tolerates two handles writing sequentially", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-index-wal-"));
    const dbPath = resolve(tempDir, "index.db");

    const first = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
    });
    const second = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
    });

    expect(first.journalMode.toLowerCase()).toBe("wal");
    expect(second.journalMode.toLowerCase()).toBe("wal");

    indexFileMetadataBatch(first.db, [makeEntry(1)], {
      nowIso: () => "2026-03-05T00:00:00.000Z",
    });
    indexFileMetadataBatch(second.db, [makeEntry(2)], {
      nowIso: () => "2026-03-05T00:00:01.000Z",
    });

    const count =
      first.db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM files;`).get()
        ?.count ?? -1;
    expect(count).toBe(2);
    first.close();
    second.close();
  });

  test("supports no-index mode by skipping database creation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-no-index-"));
    const dbPath = resolve(tempDir, "cache/index.db");

    const handle = openSqliteIndexIfEnabled({
      enabled: false,
      dbPath,
      rebuildOnSchemaChange: true,
    });

    expect(handle).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
  });

  test("single-file re-index in a 1000-file set stays fast", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    const baseline = Array.from({ length: 1000 }, (_, index) => makeEntry(index + 1));
    indexFileMetadataBatch(handle.db, baseline, {
      nowIso: () => "2026-03-05T00:00:00.000Z",
    });

    const scanned = baseline.map((entry) =>
      entry.path === "src/file-0500.ts"
        ? { ...entry, mtime: entry.mtime + 1, hash: "hash-500-updated" }
        : entry,
    );

    const start = Date.now();
    const result = applyIncrementalIndexUpdate(handle.db, scanned, {
      nowIso: () => "2026-03-05T00:01:00.000Z",
    });
    const elapsedMs = Date.now() - start;

    expect(result.upsertedCount).toBe(1);
    expect(result.unchangedCount).toBe(999);
    expect(elapsedMs).toBeLessThan(100);
    handle.close();
  });

  test("rebuild helper keeps behavior deterministic in-memory", () => {
    const db = new Database(":memory:");
    const first = initializeIndexSchema(db, { rebuildOnSchemaChange: true });
    db.query(`UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version';`).run("0");
    const second = initializeIndexSchema(db, { rebuildOnSchemaChange: true });

    expect(first.initialized).toBe(true);
    expect(second.rebuilt).toBe(true);
    db.close();
  });

  test("opens and writes index database through a symlinked cache directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ctx-index-symlink-"));
    const realCacheDir = resolve(tempDir, "real-cache");
    const symlinkCacheDir = resolve(tempDir, "cache-link");
    const dbPathViaLink = resolve(symlinkCacheDir, "index.db");
    mkdirSync(realCacheDir, { recursive: true });

    let symlinkReady = true;
    try {
      symlinkSync(realCacheDir, symlinkCacheDir, "dir");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["EPERM", "EACCES", "EOPNOTSUPP", "ENOTSUP"].includes(
          String((error as { code?: string }).code ?? ""),
        )
      ) {
        symlinkReady = false;
      } else {
        throw error;
      }
    }
    if (!symlinkReady) {
      return;
    }

    const handle = openSqliteIndex({
      dbPath: dbPathViaLink,
      rebuildOnSchemaChange: true,
    });
    indexFileMetadataBatch(handle.db, [makeEntry(1)], {
      nowIso: () => "2026-03-05T00:00:00.000Z",
    });
    const count =
      handle.db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM files;`).get()
        ?.count ?? -1;
    expect(count).toBe(1);
    handle.close();

    expect(existsSync(resolve(realCacheDir, "index.db"))).toBe(true);
  });
});
