import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  INDEX_SCHEMA_VERSION,
  initializeIndexSchema,
} from "../../src/index-manager";

function hasTable(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1;`,
    )
    .get(tableName);
  return row !== null;
}

function hasIndex(db: Database, indexName: string): boolean {
  const row = db
    .query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1;`,
    )
    .get(indexName);
  return row !== null;
}

describe("index schema initialization", () => {
  test("creates expected tables and indexes on first run", () => {
    const db = new Database(":memory:");
    const result = initializeIndexSchema(db, { rebuildOnSchemaChange: true });

    expect(result.initialized).toBe(true);
    expect(result.rebuilt).toBe(false);
    expect(result.currentVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(hasTable(db, "files")).toBe(true);
    expect(hasTable(db, "symbols")).toBe(true);
    expect(hasTable(db, "imports")).toBe(true);
    expect(hasTable(db, "schema_meta")).toBe(true);
    expect(hasIndex(db, "idx_files_path")).toBe(true);
    expect(hasIndex(db, "idx_symbols_file_id")).toBe(true);
    expect(hasIndex(db, "idx_symbols_name")).toBe(true);
    expect(hasIndex(db, "idx_imports_file_id")).toBe(true);
    expect(hasIndex(db, "idx_imports_imported_path")).toBe(true);
    db.close();
  });

  test("rebuilds schema when version mismatches and rebuild is enabled", () => {
    const db = new Database(":memory:");
    initializeIndexSchema(db, { rebuildOnSchemaChange: true });

    db.query(
      `INSERT INTO files (path, size, mtime, content_hash, language, line_count, indexed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);`,
    ).run("src/index.ts", 120, 1700000000, "hash-1", "ts", 42, "2026-03-05T00:00:00Z");
    db.query(
      `UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version';`,
    ).run("0");

    const result = initializeIndexSchema(db, { rebuildOnSchemaChange: true });

    expect(result.rebuilt).toBe(true);
    expect(result.previousVersion).toBe("0");
    expect(result.currentVersion).toBe(INDEX_SCHEMA_VERSION);
    const fileCount =
      db.query<{ count: number }>(`SELECT COUNT(*) as count FROM files;`).get()?.count ??
      -1;
    expect(fileCount).toBe(0);
    db.close();
  });

  test("throws on version mismatch when rebuild is disabled", () => {
    const db = new Database(":memory:");
    initializeIndexSchema(db, { rebuildOnSchemaChange: true });
    db.query(
      `UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version';`,
    ).run("0");

    expect(() =>
      initializeIndexSchema(db, { rebuildOnSchemaChange: false }),
    ).toThrow("Index schema version mismatch");
    db.close();
  });

  test("is idempotent when schema version already matches", () => {
    const db = new Database(":memory:");
    initializeIndexSchema(db, { rebuildOnSchemaChange: true });
    db.query(
      `INSERT INTO files (path, size, mtime, content_hash, language, line_count, indexed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);`,
    ).run("src/keep.ts", 10, 1700000001, "hash-2", "ts", 3, "2026-03-05T00:00:01Z");

    const result = initializeIndexSchema(db, { rebuildOnSchemaChange: true });
    const fileCount =
      db.query<{ count: number }>(`SELECT COUNT(*) as count FROM files;`).get()?.count ??
      -1;

    expect(result.initialized).toBe(false);
    expect(result.rebuilt).toBe(false);
    expect(fileCount).toBe(1);
    db.close();
  });
});
