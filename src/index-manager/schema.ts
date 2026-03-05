export const INDEX_SCHEMA_VERSION = "1";
export const SCHEMA_VERSION_KEY = "schema_version";

export const MANAGED_TABLES = ["files", "symbols", "imports", "schema_meta"] as const;

export interface SqliteStatementLike<TResult = unknown> {
  get(...params: unknown[]): TResult | null;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  query<TResult = unknown>(sql: string): SqliteStatementLike<TResult>;
}

export interface InitializeIndexSchemaOptions {
  rebuildOnSchemaChange: boolean;
  expectedVersion?: string;
}

export interface InitializeIndexSchemaResult {
  initialized: boolean;
  rebuilt: boolean;
  previousVersion: string | null;
  currentVersion: string;
}

const TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    line_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    signature TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    end_line INTEGER,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    imported_path TEXT NOT NULL,
    imported_names TEXT NOT NULL,
    is_reexport INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
];

const INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);`,
  `CREATE INDEX IF NOT EXISTS idx_imports_file_id ON imports(file_id);`,
  `CREATE INDEX IF NOT EXISTS idx_imports_imported_path ON imports(imported_path);`,
];

const DROP_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS imports;`,
  `DROP TABLE IF EXISTS symbols;`,
  `DROP TABLE IF EXISTS files;`,
  `DROP TABLE IF EXISTS schema_meta;`,
];

function hasTable(db: SqliteDatabaseLike, tableName: string): boolean {
  const row = db
    .query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1;`,
    )
    .get(tableName);
  return row !== null;
}

function readSchemaVersion(db: SqliteDatabaseLike): string | null {
  if (!hasTable(db, "schema_meta")) {
    return null;
  }

  const row = db
    .query<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = ?1 LIMIT 1;`,
    )
    .get(SCHEMA_VERSION_KEY);
  return row?.value ?? null;
}

function writeSchemaVersion(db: SqliteDatabaseLike, version: string): void {
  db.query(
    `INSERT INTO schema_meta (key, value)
     VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  ).run(SCHEMA_VERSION_KEY, version);
}

function applySchema(db: SqliteDatabaseLike): void {
  for (const statement of TABLE_STATEMENTS) {
    db.exec(statement);
  }
  for (const statement of INDEX_STATEMENTS) {
    db.exec(statement);
  }
}

function dropSchema(db: SqliteDatabaseLike): void {
  for (const statement of DROP_STATEMENTS) {
    db.exec(statement);
  }
}

export function initializeIndexSchema(
  db: SqliteDatabaseLike,
  options: InitializeIndexSchemaOptions,
): InitializeIndexSchemaResult {
  const expectedVersion = options.expectedVersion ?? INDEX_SCHEMA_VERSION;
  db.exec("PRAGMA foreign_keys = ON;");

  const previousVersion = readSchemaVersion(db);
  if (previousVersion === null) {
    applySchema(db);
    writeSchemaVersion(db, expectedVersion);
    return {
      initialized: true,
      rebuilt: false,
      previousVersion: null,
      currentVersion: expectedVersion,
    };
  }

  if (previousVersion !== expectedVersion) {
    if (!options.rebuildOnSchemaChange) {
      throw new Error(
        `Index schema version mismatch: database=${previousVersion} expected=${expectedVersion}`,
      );
    }

    dropSchema(db);
    applySchema(db);
    writeSchemaVersion(db, expectedVersion);
    return {
      initialized: true,
      rebuilt: true,
      previousVersion,
      currentVersion: expectedVersion,
    };
  }

  applySchema(db);
  return {
    initialized: false,
    rebuilt: false,
    previousVersion,
    currentVersion: expectedVersion,
  };
}
