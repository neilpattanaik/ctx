import type { Database } from "bun:sqlite";
import { stableSort } from "../utils/deterministic";
import type { SymbolInfo, SymbolKind } from "../types";

const DEFAULT_LANGUAGE = "text";

const VALID_SYMBOL_KINDS = new Set<SymbolKind>([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "method",
  "module",
  "unknown",
]);

const RESERVED_NAME_TOKENS = new Set([
  "as",
  "async",
  "class",
  "const",
  "def",
  "enum",
  "export",
  "fn",
  "function",
  "from",
  "if",
  "impl",
  "import",
  "interface",
  "let",
  "module",
  "private",
  "protected",
  "pub",
  "public",
  "record",
  "static",
  "struct",
  "trait",
  "type",
  "use",
  "var",
]);

export interface CodemapCacheEntry {
  path: string;
  contentHash: string;
  language: string;
  symbols: SymbolInfo[];
}

export interface UpsertCodemapCacheEntryInput {
  path: string;
  contentHash: string;
  language?: string;
  symbols: readonly SymbolInfo[];
}

export interface UpsertCodemapCacheEntriesOptions {
  indexedAt?: string;
}

export interface UpsertCodemapCacheEntriesResult {
  upsertedFiles: number;
  upsertedSymbols: number;
  indexedAt: string;
}

function toSymbolKind(value: string): SymbolKind {
  if (VALID_SYMBOL_KINDS.has(value as SymbolKind)) {
    return value as SymbolKind;
  }
  return "unknown";
}

function compareSymbols(left: SymbolInfo, right: SymbolInfo): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  const signatureCompare = left.signature.localeCompare(right.signature);
  if (signatureCompare !== 0) {
    return signatureCompare;
  }
  return left.kind.localeCompare(right.kind);
}

function deriveSymbolName(signature: string): string {
  const tokens = signature.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const token of tokens) {
    if (!RESERVED_NAME_TOKENS.has(token)) {
      return token;
    }
  }
  return tokens[0] ?? "symbol";
}

export function readCodemapCacheEntry(
  db: Database,
  path: string,
): CodemapCacheEntry | null {
  const fileRow = db
    .query<{ id: number; content_hash: string; language: string }>(
      `SELECT id, content_hash, language
       FROM files
       WHERE path = ?1
       LIMIT 1;`,
    )
    .get(path);

  if (!fileRow) {
    return null;
  }

  const symbolRows = db
    .query<{
      kind: string;
      signature: string;
      line_number: number;
      end_line: number | null;
    }>(
      `SELECT kind, signature, line_number, end_line
       FROM symbols
       WHERE file_id = ?1
       ORDER BY line_number ASC, signature ASC, kind ASC;`,
    )
    .all(fileRow.id);

  const symbols: SymbolInfo[] = symbolRows.map((row) => ({
    kind: toSymbolKind(row.kind),
    signature: row.signature,
    line: row.line_number,
    endLine: row.end_line ?? undefined,
  }));

  return {
    path,
    contentHash: fileRow.content_hash,
    language: fileRow.language,
    symbols,
  };
}

function normalizeInputEntries(
  entries: readonly UpsertCodemapCacheEntryInput[],
): UpsertCodemapCacheEntryInput[] {
  return entries.map((entry) => ({
    path: entry.path,
    contentHash: entry.contentHash,
    language: entry.language?.trim() || DEFAULT_LANGUAGE,
    symbols: stableSort([...entry.symbols], compareSymbols),
  }));
}

export function upsertCodemapCacheEntries(
  db: Database,
  entries: readonly UpsertCodemapCacheEntryInput[],
  options: UpsertCodemapCacheEntriesOptions = {},
): UpsertCodemapCacheEntriesResult {
  if (entries.length === 0) {
    return {
      upsertedFiles: 0,
      upsertedSymbols: 0,
      indexedAt: options.indexedAt ?? new Date().toISOString(),
    };
  }

  const indexedAt = options.indexedAt ?? new Date().toISOString();
  const normalizedEntries = normalizeInputEntries(entries).sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  const upsertFileStatement = db.query(
    `INSERT INTO files (path, size, mtime, content_hash, language, line_count, indexed_at)
     VALUES (?1, 0, 0, ?2, ?3, 0, ?4)
     ON CONFLICT(path) DO UPDATE SET
       content_hash = excluded.content_hash,
       language = excluded.language,
       indexed_at = excluded.indexed_at;`,
  );
  const selectFileIdStatement = db.query<{ id: number }>(
    `SELECT id FROM files WHERE path = ?1 LIMIT 1;`,
  );
  const deleteSymbolsStatement = db.query(`DELETE FROM symbols WHERE file_id = ?1;`);
  const insertSymbolStatement = db.query(
    `INSERT INTO symbols (file_id, kind, name, signature, line_number, end_line)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6);`,
  );

  let totalSymbols = 0;
  const runTransaction = db.transaction(() => {
    for (const entry of normalizedEntries) {
      upsertFileStatement.run(
        entry.path,
        entry.contentHash,
        entry.language ?? DEFAULT_LANGUAGE,
        indexedAt,
      );

      const fileIdRow = selectFileIdStatement.get(entry.path);
      if (!fileIdRow) {
        throw new Error(`Failed to resolve file id after upsert: ${entry.path}`);
      }

      deleteSymbolsStatement.run(fileIdRow.id);

      for (const symbol of entry.symbols) {
        insertSymbolStatement.run(
          fileIdRow.id,
          symbol.kind,
          deriveSymbolName(symbol.signature),
          symbol.signature,
          symbol.line,
          symbol.endLine ?? null,
        );
        totalSymbols += 1;
      }
    }
  });

  runTransaction();

  return {
    upsertedFiles: normalizedEntries.length,
    upsertedSymbols: totalSymbols,
    indexedAt,
  };
}

export function upsertCodemapCacheEntry(
  db: Database,
  entry: UpsertCodemapCacheEntryInput,
  options: UpsertCodemapCacheEntriesOptions = {},
): UpsertCodemapCacheEntriesResult {
  return upsertCodemapCacheEntries(db, [entry], options);
}
