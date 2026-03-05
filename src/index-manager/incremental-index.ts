import type { Database } from "bun:sqlite";
import type { FileEntry } from "../types";
import { indexFileMetadataBatch } from "./metadata-index";

export interface IndexedFileState {
  path: string;
  mtime: number;
  contentHash: string;
}

export interface IncrementalTouchEntry {
  path: string;
  mtime: number;
}

export interface IncrementalIndexPlan {
  upsertEntries: FileEntry[];
  touchEntries: IncrementalTouchEntry[];
  deletePaths: string[];
  unchangedPaths: string[];
}

export interface IncrementalHashOptions {
  hashResolver?: (entry: FileEntry) => string;
}

export interface ApplyIncrementalIndexOptions extends IncrementalHashOptions {
  nowIso?: () => string;
}

export interface ApplyIncrementalIndexResult {
  upsertedCount: number;
  touchedCount: number;
  deletedCount: number;
  unchangedCount: number;
  indexedAt: string;
}

function sortPaths(paths: readonly string[]): string[] {
  return paths.slice().sort((left, right) => left.localeCompare(right));
}

function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return entries.slice().sort((left, right) => left.path.localeCompare(right.path));
}

export function loadIndexedFileState(db: Database): Map<string, IndexedFileState> {
  const rows = db
    .query<{ path: string; mtime: number; content_hash: string }>(
      `SELECT path, mtime, content_hash
       FROM files
       ORDER BY path ASC;`,
    )
    .all();

  const state = new Map<string, IndexedFileState>();
  for (const row of rows) {
    state.set(row.path, {
      path: row.path,
      mtime: row.mtime,
      contentHash: row.content_hash,
    });
  }
  return state;
}

function resolveHash(entry: FileEntry, options?: IncrementalHashOptions): string {
  if (entry.hash) {
    return entry.hash;
  }
  return options?.hashResolver?.(entry) ?? "";
}

export function planIncrementalIndexUpdate(
  indexedState: Map<string, IndexedFileState>,
  scannedEntries: readonly FileEntry[],
  options?: IncrementalHashOptions,
): IncrementalIndexPlan {
  const seen = new Set<string>();
  const upsertEntries: FileEntry[] = [];
  const touchEntries: IncrementalTouchEntry[] = [];
  const unchangedPaths: string[] = [];

  for (const entry of sortEntries(scannedEntries)) {
    seen.add(entry.path);
    const existing = indexedState.get(entry.path);
    if (!existing) {
      upsertEntries.push({
        ...entry,
        hash: resolveHash(entry, options),
      });
      continue;
    }

    if (existing.mtime === entry.mtime) {
      unchangedPaths.push(entry.path);
      continue;
    }

    const nextHash = resolveHash(entry, options);
    if (nextHash !== "" && nextHash === existing.contentHash) {
      touchEntries.push({
        path: entry.path,
        mtime: entry.mtime,
      });
      continue;
    }

    upsertEntries.push({
      ...entry,
      hash: nextHash || entry.hash,
    });
  }

  const deletePaths = sortPaths(
    [...indexedState.keys()].filter((pathValue) => !seen.has(pathValue)),
  );

  return {
    upsertEntries: sortEntries(upsertEntries),
    touchEntries: touchEntries.sort((left, right) => left.path.localeCompare(right.path)),
    deletePaths,
    unchangedPaths: sortPaths(unchangedPaths),
  };
}

export function applyIncrementalIndexUpdate(
  db: Database,
  scannedEntries: readonly FileEntry[],
  options?: ApplyIncrementalIndexOptions,
): ApplyIncrementalIndexResult {
  const indexedAt = options?.nowIso?.() ?? new Date().toISOString();
  const plan = planIncrementalIndexUpdate(
    loadIndexedFileState(db),
    scannedEntries,
    options,
  );

  const updateTouchStatement = db.query(
    `UPDATE files
     SET mtime = ?2,
         indexed_at = ?3
     WHERE path = ?1;`,
  );
  const deleteStatement = db.query(`DELETE FROM files WHERE path = ?1;`);

  const applyPlan = db.transaction(() => {
    if (plan.upsertEntries.length > 0) {
      indexFileMetadataBatch(db, plan.upsertEntries, {
        nowIso: () => indexedAt,
        wrapInTransaction: false,
      });
    }

    for (const entry of plan.touchEntries) {
      updateTouchStatement.run(entry.path, entry.mtime, indexedAt);
    }

    for (const pathValue of plan.deletePaths) {
      deleteStatement.run(pathValue);
    }
  });

  applyPlan();

  return {
    upsertedCount: plan.upsertEntries.length,
    touchedCount: plan.touchEntries.length,
    deletedCount: plan.deletePaths.length,
    unchangedCount: plan.unchangedPaths.length,
    indexedAt,
  };
}
