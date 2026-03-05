import { describe, expect, test } from "bun:test";
import { openSqliteIndex } from "../../src/index-manager/sqlite-index";
import {
  detectLanguageFromPath,
  indexFileMetadataBatch,
} from "../../src/index-manager/metadata-index";
import type { FileEntry } from "../../src/types";

function fileEntry(
  path: string,
  overrides?: Partial<FileEntry>,
): FileEntry {
  return {
    path,
    size: 100,
    mtime: 1700000000,
    hash: "hash-1",
    language: "text",
    isText: true,
    ...overrides,
  };
}

describe("file metadata indexing", () => {
  test("maps known extensions to deterministic language ids", () => {
    expect(detectLanguageFromPath("src/a.ts")).toBe("typescript");
    expect(detectLanguageFromPath("src/a.tsx")).toBe("typescriptreact");
    expect(detectLanguageFromPath("src/a.py")).toBe("python");
    expect(detectLanguageFromPath("src/a.rs")).toBe("rust");
    expect(detectLanguageFromPath("src/a.unknown")).toBe("text");
  });

  test("upserts file metadata in a single transaction", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    const firstBatch: FileEntry[] = [
      fileEntry("src/b.ts", { size: 200, hash: "hash-b" }),
      fileEntry("src/a.custom", { language: "customlang", hash: "hash-a" }),
    ];

    const firstResult = indexFileMetadataBatch(handle.db, firstBatch, {
      nowIso: () => "2026-03-05T00:00:00.000Z",
    });
    expect(firstResult.upsertedCount).toBe(2);

    const firstRows = handle.db
      .query<{
        path: string;
        size: number;
        content_hash: string;
        language: string;
        indexed_at: string;
      }>(
        `SELECT path, size, content_hash, language, indexed_at
         FROM files
         ORDER BY path ASC;`,
      )
      .all();

    expect(firstRows).toEqual([
      {
        path: "src/a.custom",
        size: 100,
        content_hash: "hash-a",
        language: "customlang",
        indexed_at: "2026-03-05T00:00:00.000Z",
      },
      {
        path: "src/b.ts",
        size: 200,
        content_hash: "hash-b",
        language: "typescript",
        indexed_at: "2026-03-05T00:00:00.000Z",
      },
    ]);

    const secondBatch: FileEntry[] = [
      fileEntry("src/b.ts", { size: 300, hash: "hash-b2", mtime: 1700000010 }),
    ];
    const secondResult = indexFileMetadataBatch(handle.db, secondBatch, {
      nowIso: () => "2026-03-05T00:10:00.000Z",
    });

    expect(secondResult.upsertedCount).toBe(1);
    const updated = handle.db
      .query<{
        size: number;
        content_hash: string;
        indexed_at: string;
      }>(
        `SELECT size, content_hash, indexed_at
         FROM files
         WHERE path = ?1;`,
      )
      .get("src/b.ts");

    expect(updated).toEqual({
      size: 300,
      content_hash: "hash-b2",
      indexed_at: "2026-03-05T00:10:00.000Z",
    });
    handle.close();
  });
});
