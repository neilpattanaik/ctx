import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  INDEX_SCHEMA_VERSION,
  initializeIndexSchema,
  type InitializeIndexSchemaResult,
} from "./schema";

export interface ResolveIndexDatabasePathOptions {
  repoRoot: string;
  cacheDir?: string;
}

export interface OpenSqliteIndexOptions {
  dbPath: string;
  rebuildOnSchemaChange: boolean;
  expectedSchemaVersion?: string;
}

export interface OpenSqliteIndexIfEnabledOptions extends OpenSqliteIndexOptions {
  enabled: boolean;
}

export interface SqliteIndexHandle {
  db: Database;
  dbPath: string;
  schema: InitializeIndexSchemaResult;
  journalMode: string;
  close: () => void;
}

function isLikelyDatabaseFile(pathValue: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(pathValue);
}

export function resolveIndexDatabasePath(
  options: ResolveIndexDatabasePathOptions,
): string {
  const repoRoot = resolve(options.repoRoot);
  const cacheDir = options.cacheDir?.trim();

  if (!cacheDir) {
    return resolve(repoRoot, ".ctx", "index.db");
  }

  const basePath = isAbsolute(cacheDir) ? cacheDir : resolve(repoRoot, cacheDir);
  if (isLikelyDatabaseFile(basePath)) {
    return resolve(basePath);
  }

  return resolve(basePath, "index.db");
}

export function openSqliteIndex(options: OpenSqliteIndexOptions): SqliteIndexHandle {
  const dbPath = options.dbPath === ":memory:" ? ":memory:" : resolve(options.dbPath);
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, {
    create: true,
    readonly: false,
  });

  try {
    const journalModeRow = db
      .query<{ journal_mode: string }>(`PRAGMA journal_mode = WAL;`)
      .get();
    const journalMode = journalModeRow?.journal_mode ?? "unknown";
    const schema = initializeIndexSchema(db, {
      rebuildOnSchemaChange: options.rebuildOnSchemaChange,
      expectedVersion: options.expectedSchemaVersion ?? INDEX_SCHEMA_VERSION,
    });
    return {
      db,
      dbPath,
      schema,
      journalMode,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openSqliteIndexIfEnabled(
  options: OpenSqliteIndexIfEnabledOptions,
): SqliteIndexHandle | null {
  if (!options.enabled) {
    return null;
  }

  return openSqliteIndex({
    dbPath: options.dbPath,
    rebuildOnSchemaChange: options.rebuildOnSchemaChange,
    expectedSchemaVersion: options.expectedSchemaVersion,
  });
}
