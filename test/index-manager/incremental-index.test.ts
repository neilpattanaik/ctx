import { describe, expect, test } from "bun:test";
import type { FileEntry } from "../../src/types";
import {
  applyIncrementalIndexUpdate,
  indexFileMetadataBatch,
  loadIndexedFileState,
  openSqliteIndex,
  planIncrementalIndexUpdate,
} from "../../src/index-manager";

function fileEntry(
  path: string,
  overrides?: Partial<FileEntry>,
): FileEntry {
  return {
    path,
    size: 100,
    mtime: 1700000000,
    hash: "hash-default",
    language: "typescript",
    isText: true,
    ...overrides,
  };
}

describe("incremental index update logic", () => {
  test("plans deterministic upsert/touch/delete/unchanged groups", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    indexFileMetadataBatch(
      handle.db,
      [
        fileEntry("src/a.ts", { mtime: 10, hash: "h-a" }),
        fileEntry("src/b.ts", { mtime: 10, hash: "h-b" }),
        fileEntry("src/c.ts", { mtime: 10, hash: "h-c" }),
        fileEntry("src/deleted.ts", { mtime: 10, hash: "h-del" }),
      ],
      { nowIso: () => "2026-03-05T00:00:00.000Z" },
    );

    const scanned: FileEntry[] = [
      fileEntry("src/a.ts", { mtime: 10, hash: "h-a" }),
      fileEntry("src/b.ts", { mtime: 20, hash: "h-b" }),
      fileEntry("src/c.ts", { mtime: 20, hash: "h-c2" }),
      fileEntry("src/new.ts", { mtime: 20, hash: "h-new" }),
    ];

    const plan = planIncrementalIndexUpdate(loadIndexedFileState(handle.db), scanned);

    expect(plan.unchangedPaths).toEqual(["src/a.ts"]);
    expect(plan.touchEntries).toEqual([{ path: "src/b.ts", mtime: 20 }]);
    expect(plan.upsertEntries.map((entry) => entry.path)).toEqual([
      "src/c.ts",
      "src/new.ts",
    ]);
    expect(plan.deletePaths).toEqual(["src/deleted.ts"]);
    handle.close();
  });

  test("applies incremental plan in a single deterministic flow", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    indexFileMetadataBatch(
      handle.db,
      [
        fileEntry("src/a.ts", { mtime: 10, hash: "h-a", size: 100 }),
        fileEntry("src/b.ts", { mtime: 10, hash: "h-b", size: 200 }),
        fileEntry("src/c.ts", { mtime: 10, hash: "h-c", size: 300 }),
      ],
      { nowIso: () => "2026-03-05T00:00:00.000Z" },
    );

    const result = applyIncrementalIndexUpdate(
      handle.db,
      [
        fileEntry("src/a.ts", { mtime: 10, hash: "h-a", size: 100 }),
        fileEntry("src/b.ts", { mtime: 20, hash: "h-b", size: 220 }),
        fileEntry("src/c.ts", { mtime: 20, hash: "h-c2", size: 330 }),
        fileEntry("src/new.ts", { mtime: 20, hash: "h-new", size: 90 }),
      ],
      { nowIso: () => "2026-03-05T00:10:00.000Z" },
    );

    expect(result).toEqual({
      upsertedCount: 2,
      touchedCount: 1,
      deletedCount: 0,
      unchangedCount: 1,
      indexedAt: "2026-03-05T00:10:00.000Z",
    });

    const rows = handle.db
      .query<{
        path: string;
        size: number;
        mtime: number;
        content_hash: string;
        indexed_at: string;
      }>(
        `SELECT path, size, mtime, content_hash, indexed_at
         FROM files
         ORDER BY path ASC;`,
      )
      .all();

    expect(rows).toEqual([
      {
        path: "src/a.ts",
        size: 100,
        mtime: 10,
        content_hash: "h-a",
        indexed_at: "2026-03-05T00:00:00.000Z",
      },
      {
        path: "src/b.ts",
        size: 200,
        mtime: 20,
        content_hash: "h-b",
        indexed_at: "2026-03-05T00:10:00.000Z",
      },
      {
        path: "src/c.ts",
        size: 330,
        mtime: 20,
        content_hash: "h-c2",
        indexed_at: "2026-03-05T00:10:00.000Z",
      },
      {
        path: "src/new.ts",
        size: 90,
        mtime: 20,
        content_hash: "h-new",
        indexed_at: "2026-03-05T00:10:00.000Z",
      },
    ]);
    handle.close();
  });

  test("deletes index rows that are missing from the current scan", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    indexFileMetadataBatch(
      handle.db,
      [
        fileEntry("src/keep.ts", { hash: "keep" }),
        fileEntry("src/remove.ts", { hash: "remove" }),
      ],
      { nowIso: () => "2026-03-05T00:00:00.000Z" },
    );

    const result = applyIncrementalIndexUpdate(
      handle.db,
      [fileEntry("src/keep.ts", { hash: "keep" })],
      { nowIso: () => "2026-03-05T00:05:00.000Z" },
    );

    expect(result.deletedCount).toBe(1);
    const paths = handle.db
      .query<{ path: string }>(`SELECT path FROM files ORDER BY path ASC;`)
      .all()
      .map((row) => row.path);

    expect(paths).toEqual(["src/keep.ts"]);
    handle.close();
  });
});
