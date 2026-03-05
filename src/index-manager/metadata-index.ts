import { extname } from "node:path";
import type { Database } from "bun:sqlite";
import type { FileEntry } from "../types";

export const DEFAULT_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".bash": "shell",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascriptreact",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "shell",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".txt": "text",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export interface IndexFileMetadataOptions {
  nowIso?: () => string;
  wrapInTransaction?: boolean;
}

export interface IndexFileMetadataResult {
  upsertedCount: number;
  indexedAt: string;
}

function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return entries.slice().sort((left, right) => left.path.localeCompare(right.path));
}

export function detectLanguageFromPath(pathValue: string): string {
  const extension = extname(pathValue).toLowerCase();
  return DEFAULT_LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

function resolveLanguage(entry: FileEntry): string {
  const mapped = detectLanguageFromPath(entry.path);
  if (mapped !== "text") {
    return mapped;
  }
  return entry.language || "text";
}

export function indexFileMetadataBatch(
  db: Database,
  entries: readonly FileEntry[],
  options?: IndexFileMetadataOptions,
): IndexFileMetadataResult {
  if (entries.length === 0) {
    return {
      upsertedCount: 0,
      indexedAt: options?.nowIso?.() ?? new Date().toISOString(),
    };
  }

  const sortedEntries = sortEntries(entries);
  const indexedAt = options?.nowIso?.() ?? new Date().toISOString();
  const statement = db.query(
    `INSERT INTO files (path, size, mtime, content_hash, language, line_count, indexed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime = excluded.mtime,
       content_hash = excluded.content_hash,
       language = excluded.language,
       line_count = excluded.line_count,
       indexed_at = excluded.indexed_at;`,
  );

  const upsertBatch = (batch: readonly FileEntry[]): void => {
    for (const entry of batch) {
      statement.run(
        entry.path,
        entry.size,
        entry.mtime,
        entry.hash,
        resolveLanguage(entry),
        0,
        indexedAt,
      );
    }
  };

  if (options?.wrapInTransaction ?? true) {
    const runBatch = db.transaction(upsertBatch);
    runBatch(sortedEntries);
  } else {
    upsertBatch(sortedEntries);
  }

  return {
    upsertedCount: sortedEntries.length,
    indexedAt,
  };
}
