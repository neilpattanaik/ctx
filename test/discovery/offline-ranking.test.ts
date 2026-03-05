import { describe, expect, test } from "bun:test";
import {
  indexFileMetadataBatch,
  openSqliteIndex,
  type SqliteIndexHandle,
} from "../../src/index-manager";
import { rankFilesFromIndex } from "../../src/discovery/offline-ranking";
import type { ExtractedTaskTerms } from "../../src/discovery/task-terms";
import type { FileEntry } from "../../src/types";

function fileEntry(path: string, index: number): FileEntry {
  return {
    path,
    size: 100 + index,
    mtime: 1700000000 + index,
    hash: `hash-${index}`,
    language: "text",
    isText: true,
  };
}

function createTerms(partial?: Partial<ExtractedTaskTerms>): ExtractedTaskTerms {
  return {
    identifiers: [],
    paths: [],
    configKeys: [],
    endpoints: [],
    searchTerms: [],
    ...partial,
  };
}

function fileIdForPath(handle: SqliteIndexHandle, path: string): number {
  const row = handle.db
    .query<{ id: number }>(`SELECT id FROM files WHERE path = ?1 LIMIT 1;`)
    .get(path);
  if (!row) {
    throw new Error(`Missing file row for path: ${path}`);
  }
  return row.id;
}

function insertSymbol(
  handle: SqliteIndexHandle,
  path: string,
  name: string,
  signature: string,
  line = 1,
): void {
  const fileId = fileIdForPath(handle, path);
  handle.db
    .query(
      `INSERT INTO symbols (file_id, kind, name, signature, line_number, end_line)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6);`,
    )
    .run(fileId, "function", name, signature, line, null);
}

function insertImport(
  handle: SqliteIndexHandle,
  sourcePath: string,
  importedPath: string,
  importedNames: string[] = [],
): void {
  const sourceFileId = fileIdForPath(handle, sourcePath);
  handle.db
    .query(
      `INSERT INTO imports (file_id, imported_path, imported_names, is_reexport)
       VALUES (?1, ?2, ?3, 0);`,
    )
    .run(sourceFileId, importedPath, JSON.stringify(importedNames));
}

function seedFiles(handle: SqliteIndexHandle, paths: readonly string[]): void {
  indexFileMetadataBatch(
    handle.db,
    paths.map((path, index) => fileEntry(path, index)),
    { nowIso: () => "2026-03-05T00:00:00.000Z" },
  );
}

describe("rankFilesFromIndex", () => {
  test("ranks by weighted term frequency and normalizes to 0-1000", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, [
        "src/auth/login.ts",
        "src/auth/oauth.ts",
        "src/billing/invoice.ts",
      ]);

      insertSymbol(
        handle,
        "src/auth/login.ts",
        "loginUser",
        "function loginUser(authToken) { return loginAuthToken(authToken); }",
      );
      insertSymbol(
        handle,
        "src/auth/oauth.ts",
        "exchangeOAuthCode",
        "function exchangeOAuthCode(oauthToken) { return oauthToken; }",
      );
      insertSymbol(
        handle,
        "src/billing/invoice.ts",
        "generateInvoice",
        "function generateInvoice(invoice) { return invoice; }",
      );

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          identifiers: ["LoginFlow"],
          searchTerms: ["login", "auth", "token", "oauth"],
        }),
      );

      expect(ranking.map((entry) => entry.path)).toEqual([
        "src/auth/login.ts",
        "src/auth/oauth.ts",
      ]);
      expect(ranking[0]?.score).toBe(1000);
      expect(ranking.every((entry) => entry.score >= 0 && entry.score <= 1000)).toBe(
        true,
      );
    } finally {
      handle.close();
    }
  });

  test("applies explicit path-component boosts from task path terms", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, ["src/app/login.ts", "src/zones/login.ts"]);
      insertSymbol(
        handle,
        "src/app/login.ts",
        "handleLogin",
        "function handleLogin() { return true; }",
      );
      insertSymbol(
        handle,
        "src/zones/login.ts",
        "handleLogin",
        "function handleLogin() { return true; }",
      );

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          paths: ["src/zones/login.ts"],
          searchTerms: ["login"],
        }),
      );

      expect(ranking[0]?.path).toBe("src/zones/login.ts");
      expect(ranking[0]?.pathHitCount).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("boosts files imported by high-scoring files", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, ["src/main.ts", "src/service.ts", "src/other.ts"]);
      insertSymbol(
        handle,
        "src/main.ts",
        "loginMain",
        "function loginMain(token) { return token; }",
      );
      insertSymbol(
        handle,
        "src/service.ts",
        "serviceCore",
        "function serviceCore() { return 1; }",
      );
      insertSymbol(
        handle,
        "src/other.ts",
        "otherWork",
        "function otherWork() { return 1; }",
      );
      insertImport(handle, "src/main.ts", "src/service.ts", ["serviceCore"]);

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          searchTerms: ["login", "token"],
        }),
        { importProximityFactor: 0.6 },
      );

      expect(ranking.map((entry) => entry.path)).toEqual([
        "src/main.ts",
        "src/service.ts",
      ]);
      expect(ranking[1]?.importProximityBoost).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("applies explicit entrypoint boosts", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, ["src/main.ts", "src/worker.ts"]);
      insertSymbol(
        handle,
        "src/main.ts",
        "startServer",
        "function startServer() { return true; }",
      );
      insertSymbol(
        handle,
        "src/worker.ts",
        "startServer",
        "function startServer() { return true; }",
      );

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          searchTerms: ["start", "server"],
        }),
        {
          entrypointPaths: ["src/main.ts"],
          entrypointBoost: 250,
        },
      );

      expect(ranking[0]?.path).toBe("src/main.ts");
      expect(ranking[0]?.entrypointBoost).toBe(250);
      expect(ranking[1]?.entrypointBoost).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("breaks ties deterministically by path", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, ["src/b.ts", "src/a.ts"]);
      insertSymbol(handle, "src/a.ts", "sharedFn", "function sharedFn() {}");
      insertSymbol(handle, "src/b.ts", "sharedFn", "function sharedFn() {}");

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          searchTerms: ["shared"],
        }),
        {
          pathTermWeight: 0,
          breadthBonusPerTerm: 0,
          importProximityFactor: 0,
          entrypointBoost: 0,
        },
      );

      expect(ranking.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(ranking[0]?.rawScore).toBe(ranking[1]?.rawScore);
      expect(ranking[0]?.score).toBe(ranking[1]?.score);
    } finally {
      handle.close();
    }
  });

  test("applies git-diff bias for changed files, importers, and matching tests", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    try {
      seedFiles(handle, [
        "src/auth/login.ts",
        "src/app.ts",
        "test/auth/login.test.ts",
        "src/neutral.ts",
      ]);
      insertSymbol(handle, "src/auth/login.ts", "loginCore", "function loginCore() {}");
      insertSymbol(handle, "src/app.ts", "runApp", "function runApp() {}");
      insertSymbol(
        handle,
        "test/auth/login.test.ts",
        "loginTest",
        "function loginTest() {}",
      );
      insertImport(handle, "src/app.ts", "src/auth/login.ts");

      const ranking = rankFilesFromIndex(
        handle.db,
        createTerms({
          searchTerms: [],
        }),
        {
          gitChangedPaths: ["src/auth/login.ts"],
          reviewMode: true,
          importProximityFactor: 0,
          pathTermWeight: 0,
          breadthBonusPerTerm: 0,
          entrypointBoost: 0,
        },
      );

      expect(ranking.map((entry) => entry.path)).toEqual([
        "src/auth/login.ts",
        "src/app.ts",
        "test/auth/login.test.ts",
      ]);
      expect(ranking[0]?.gitBiasBoost).toBeGreaterThan(0);
      expect(ranking[0]?.gitBiasReasons).toContain("changed_file");
      expect(ranking[0]?.reviewModeSuggestedMode).toBe("full");
      expect(ranking[1]?.gitBiasReasons).toContain("imports_changed_file");
      expect(ranking[2]?.gitBiasReasons).toContain("tests_changed_module");
    } finally {
      handle.close();
    }
  });
});
