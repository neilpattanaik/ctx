import { describe, expect, test } from "bun:test";
import {
  openSqliteIndex,
  type SqliteIndexHandle,
} from "../../src/index-manager";
import {
  readCodemapCacheEntry,
  upsertCodemapCacheEntries,
  upsertCodemapCacheEntry,
} from "../../src/codemap";

function createHandle(): SqliteIndexHandle {
  return openSqliteIndex({
    dbPath: ":memory:",
    rebuildOnSchemaChange: true,
  });
}

describe("codemap cache", () => {
  test("upserts and reads cached symbols in deterministic order", () => {
    const handle = createHandle();
    const result = upsertCodemapCacheEntry(handle.db, {
      path: "src/auth/service.ts",
      contentHash: "hash-auth-v1",
      language: "typescript",
      symbols: [
        {
          kind: "function",
          signature: "export function login() {}",
          line: 20,
          endLine: 22,
        },
        {
          kind: "class",
          signature: "export class AuthService {}",
          line: 5,
          endLine: 18,
        },
      ],
    });

    expect(result.upsertedFiles).toBe(1);
    expect(result.upsertedSymbols).toBe(2);

    const cached = readCodemapCacheEntry(handle.db, "src/auth/service.ts");
    expect(cached).not.toBeNull();
    expect(cached?.contentHash).toBe("hash-auth-v1");
    expect(cached?.language).toBe("typescript");
    expect(cached?.symbols.map((symbol) => symbol.kind)).toEqual([
      "class",
      "function",
    ]);

    handle.close();
  });

  test("replaces existing symbol rows for the same path on re-upsert", () => {
    const handle = createHandle();
    upsertCodemapCacheEntry(handle.db, {
      path: "src/auth/service.ts",
      contentHash: "hash-auth-v1",
      language: "typescript",
      symbols: [
        {
          kind: "class",
          signature: "export class AuthService {}",
          line: 3,
          endLine: 10,
        },
      ],
    });

    const updated = upsertCodemapCacheEntry(handle.db, {
      path: "src/auth/service.ts",
      contentHash: "hash-auth-v2",
      language: "typescript",
      symbols: [
        {
          kind: "function",
          signature: "export function refreshToken() {}",
          line: 40,
          endLine: 41,
        },
      ],
    });

    expect(updated.upsertedFiles).toBe(1);
    expect(updated.upsertedSymbols).toBe(1);

    const cached = readCodemapCacheEntry(handle.db, "src/auth/service.ts");
    expect(cached?.contentHash).toBe("hash-auth-v2");
    expect(cached?.symbols).toHaveLength(1);
    expect(cached?.symbols[0]?.signature).toContain("refreshToken");

    handle.close();
  });

  test("supports empty-symbol cache rows and missing-path reads", () => {
    const handle = createHandle();
    upsertCodemapCacheEntry(handle.db, {
      path: "src/empty.ts",
      contentHash: "hash-empty",
      language: "typescript",
      symbols: [],
    });

    const cached = readCodemapCacheEntry(handle.db, "src/empty.ts");
    expect(cached).not.toBeNull();
    expect(cached?.symbols).toEqual([]);
    expect(readCodemapCacheEntry(handle.db, "src/missing.ts")).toBeNull();

    handle.close();
  });

  test("batch upsert sorts input deterministically and reports counts", () => {
    const handle = createHandle();
    const result = upsertCodemapCacheEntries(handle.db, [
      {
        path: "src/z.ts",
        contentHash: "hash-z",
        language: "typescript",
        symbols: [{ kind: "function", signature: "function z() {}", line: 2 }],
      },
      {
        path: "src/a.ts",
        contentHash: "hash-a",
        language: "typescript",
        symbols: [{ kind: "function", signature: "function a() {}", line: 1 }],
      },
    ]);

    expect(result.upsertedFiles).toBe(2);
    expect(result.upsertedSymbols).toBe(2);

    const aCached = readCodemapCacheEntry(handle.db, "src/a.ts");
    const zCached = readCodemapCacheEntry(handle.db, "src/z.ts");
    expect(aCached?.contentHash).toBe("hash-a");
    expect(zCached?.contentHash).toBe("hash-z");

    handle.close();
  });
});
