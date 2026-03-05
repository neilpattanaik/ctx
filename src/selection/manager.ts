import type {
  CtxConfig,
  SelectionEntry,
  SelectionMode,
  SelectionPriority,
  SliceRange,
} from "../types";
import { createSelectionEntry } from "../types";
import { matchGlob } from "../utils/paths";

export interface SelectionManagerOptions {
  maxFiles: number;
  maxFullFiles: number;
  maxSlicesPerFile: number;
  maxFileBytes: number;
  neverInclude: string[];
  excludeBinary: boolean;
}

export interface SelectionAddOptions {
  priorityScore?: number;
  isBinary?: boolean;
  fileBytes?: number;
}

export type SelectionErrorCode =
  | "INVALID_SELECTION_ENTRY"
  | "MAX_FILES_EXCEEDED"
  | "MAX_FULL_FILES_EXCEEDED"
  | "BINARY_FILE_EXCLUDED"
  | "FILE_TOO_LARGE"
  | "NEVER_INCLUDE_MATCH";

export interface SelectionError {
  code: SelectionErrorCode;
  path: string;
  message: string;
}

export interface ManagedSelectionEntry extends SelectionEntry {
  priorityScore: number;
  isBinary?: boolean;
  fileBytes?: number;
}

export type SelectionAddResult =
  | {
      ok: true;
      entry: ManagedSelectionEntry;
    }
  | {
      ok: false;
      error: SelectionError;
    };

export interface SelectionSummary {
  totalFiles: number;
  byMode: Record<SelectionMode, number>;
  byPriority: Record<SelectionPriority, number>;
  entries: Array<{
    path: string;
    mode: SelectionMode;
    priority: SelectionPriority;
    priorityScore: number;
  }>;
}

export interface SelectionManifest {
  constraints: SelectionManagerOptions;
  entries: ManagedSelectionEntry[];
}

export type ConstraintActionType =
  | "drop"
  | "degrade_full_to_slices"
  | "merge_slices";

export interface ConstraintAction {
  type: ConstraintActionType;
  path: string;
  reason: string;
  beforeMode?: SelectionMode;
  afterMode?: SelectionMode;
  beforeCount?: number;
  afterCount?: number;
}

export interface ConstraintEnforcementResult {
  actions: ConstraintAction[];
  entries: ManagedSelectionEntry[];
}

const DEFAULT_PRIORITY_SCORE: Record<SelectionPriority, number> = {
  core: 300,
  support: 200,
  ref: 100,
};

function cloneSelectionEntry(entry: SelectionEntry): SelectionEntry {
  if (entry.mode === "slices") {
    return {
      ...entry,
      slices: entry.slices.map((slice) => ({ ...slice })),
    };
  }

  return { ...entry };
}

function cloneManagedEntry(entry: ManagedSelectionEntry): ManagedSelectionEntry {
  const cloned = cloneSelectionEntry(entry);
  return {
    ...cloned,
    priorityScore: entry.priorityScore,
    isBinary: entry.isBinary,
    fileBytes: entry.fileBytes,
  };
}

function compareEntriesByPriority(
  a: ManagedSelectionEntry,
  b: ManagedSelectionEntry,
): number {
  if (a.priorityScore !== b.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }
  return a.path.localeCompare(b.path);
}

function compareEntriesForConstraintDrop(
  a: ManagedSelectionEntry,
  b: ManagedSelectionEntry,
): number {
  if (a.priorityScore !== b.priorityScore) {
    return a.priorityScore - b.priorityScore;
  }
  return a.path.localeCompare(b.path);
}

function buildSelectionError(
  code: SelectionErrorCode,
  path: string,
  message: string,
): SelectionAddResult {
  return {
    ok: false,
    error: {
      code,
      path,
      message,
    },
  };
}

function countFullEntries(entries: Iterable<ManagedSelectionEntry>): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.mode === "full") {
      count += 1;
    }
  }
  return count;
}

function shouldNeverInclude(path: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(path, pattern)) {
      return true;
    }
  }
  return false;
}

function mergeTwoSlices(left: SliceRange, right: SliceRange): SliceRange {
  return {
    startLine: Math.min(left.startLine, right.startLine),
    endLine: Math.max(left.endLine, right.endLine),
    description: `${left.description}; ${right.description}`,
    rationale: `${left.rationale}; ${right.rationale}`,
  };
}

function normalizedSlices(slices: readonly SliceRange[]): SliceRange[] {
  return [...slices]
    .map((slice) => ({ ...slice }))
    .sort((a, b) => {
      if (a.startLine !== b.startLine) {
        return a.startLine - b.startLine;
      }
      return a.endLine - b.endLine;
    });
}

function mergeClosestSlices(
  slices: readonly SliceRange[],
  maxSlicesPerFile: number,
): SliceRange[] {
  const merged = normalizedSlices(slices);

  while (merged.length > maxSlicesPerFile) {
    let bestIndex = 0;
    let bestGap = Number.POSITIVE_INFINITY;

    for (let index = 0; index < merged.length - 1; index += 1) {
      const current = merged[index];
      const next = merged[index + 1];
      const gap = next.startLine - current.endLine;

      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
        continue;
      }

      if (gap === bestGap && current.startLine < merged[bestIndex].startLine) {
        bestIndex = index;
      }
    }

    const mergedSlice = mergeTwoSlices(merged[bestIndex], merged[bestIndex + 1]);
    merged.splice(bestIndex, 2, mergedSlice);
  }

  return merged;
}

export function selectionManagerOptionsFromConfig(
  config: CtxConfig,
): SelectionManagerOptions {
  return {
    maxFiles: config.defaults.maxFiles,
    maxFullFiles: config.defaults.maxFullFiles,
    maxSlicesPerFile: config.defaults.maxSlicesPerFile,
    maxFileBytes: config.repo.maxFileBytes,
    neverInclude: [...config.privacy.neverInclude],
    excludeBinary: config.repo.skipBinary,
  };
}

export class SelectionManager {
  private readonly entries = new Map<string, ManagedSelectionEntry>();
  private readonly options: SelectionManagerOptions;

  constructor(options: SelectionManagerOptions) {
    this.options = {
      maxFiles: options.maxFiles,
      maxFullFiles: options.maxFullFiles,
      maxSlicesPerFile: options.maxSlicesPerFile,
      maxFileBytes: options.maxFileBytes,
      neverInclude: [...options.neverInclude],
      excludeBinary: options.excludeBinary,
    };
  }

  add(entry: SelectionEntry, addOptions: SelectionAddOptions = {}): SelectionAddResult {
    let validatedEntry: SelectionEntry;
    try {
      validatedEntry = createSelectionEntry(entry);
    } catch (error) {
      return buildSelectionError(
        "INVALID_SELECTION_ENTRY",
        entry.path,
        error instanceof Error ? error.message : "Invalid selection entry",
      );
    }

    if (shouldNeverInclude(validatedEntry.path, this.options.neverInclude)) {
      return buildSelectionError(
        "NEVER_INCLUDE_MATCH",
        validatedEntry.path,
        "Path matches never-include rule",
      );
    }

    if (addOptions.isBinary === true && this.options.excludeBinary) {
      return buildSelectionError(
        "BINARY_FILE_EXCLUDED",
        validatedEntry.path,
        "Binary files are excluded from selection",
      );
    }

    if (
      typeof addOptions.fileBytes === "number" &&
      addOptions.fileBytes > this.options.maxFileBytes
    ) {
      return buildSelectionError(
        "FILE_TOO_LARGE",
        validatedEntry.path,
        `File exceeds maxFileBytes=${this.options.maxFileBytes}`,
      );
    }

    const existingEntry = this.entries.get(validatedEntry.path);
    const nextFileCount = existingEntry ? this.entries.size : this.entries.size + 1;
    if (nextFileCount > this.options.maxFiles) {
      return buildSelectionError(
        "MAX_FILES_EXCEEDED",
        validatedEntry.path,
        `Selection would exceed maxFiles=${this.options.maxFiles}`,
      );
    }

    const currentFullCount = countFullEntries(this.entries.values());
    const existingIsFull = existingEntry?.mode === "full";
    const nextIsFull = validatedEntry.mode === "full";
    const nextFullCount =
      currentFullCount - (existingIsFull ? 1 : 0) + (nextIsFull ? 1 : 0);
    if (nextFullCount > this.options.maxFullFiles) {
      return buildSelectionError(
        "MAX_FULL_FILES_EXCEEDED",
        validatedEntry.path,
        `Selection would exceed maxFullFiles=${this.options.maxFullFiles}`,
      );
    }

    const normalizedEntry =
      validatedEntry.mode === "slices" &&
      validatedEntry.slices.length > this.options.maxSlicesPerFile
        ? {
            ...validatedEntry,
            slices: mergeClosestSlices(
              validatedEntry.slices,
              this.options.maxSlicesPerFile,
            ),
          }
        : validatedEntry;

    const priorityScore =
      addOptions.priorityScore ?? DEFAULT_PRIORITY_SCORE[normalizedEntry.priority];
    const managedEntry: ManagedSelectionEntry = {
      ...cloneSelectionEntry(normalizedEntry),
      priorityScore,
      isBinary: addOptions.isBinary,
      fileBytes: addOptions.fileBytes,
    };

    this.entries.set(normalizedEntry.path, managedEntry);
    return { ok: true, entry: cloneManagedEntry(managedEntry) };
  }

  enforceHardConstraints(): ConstraintEnforcementResult {
    const actions: ConstraintAction[] = [];

    for (const [path, entry] of this.entries) {
      if (shouldNeverInclude(path, this.options.neverInclude)) {
        this.entries.delete(path);
        actions.push({
          type: "drop",
          path,
          reason: "never-include path",
        });
        continue;
      }

      if (entry.isBinary === true && this.options.excludeBinary) {
        this.entries.delete(path);
        actions.push({
          type: "drop",
          path,
          reason: "binary exclusion",
        });
        continue;
      }

      if (
        typeof entry.fileBytes === "number" &&
        entry.fileBytes > this.options.maxFileBytes
      ) {
        this.entries.delete(path);
        actions.push({
          type: "drop",
          path,
          reason: "max_file_bytes",
        });
      }
    }

    const fullEntries = [...this.entries.values()]
      .filter((entry) => entry.mode === "full")
      .sort(compareEntriesForConstraintDrop);
    let fullCount = fullEntries.length;
    while (fullCount > this.options.maxFullFiles) {
      const target = fullEntries.shift();
      if (!target) {
        break;
      }

      const degraded: ManagedSelectionEntry = {
        ...target,
        mode: "slices",
        slices: [
          {
            startLine: 1,
            endLine: 1,
            description: "auto-degraded full selection",
            rationale: "max_full_files hard constraint",
          },
        ],
      };

      this.entries.set(target.path, degraded);
      fullCount -= 1;
      actions.push({
        type: "degrade_full_to_slices",
        path: target.path,
        reason: "max_full_files",
        beforeMode: "full",
        afterMode: "slices",
      });
    }

    for (const [path, entry] of this.entries) {
      if (entry.mode !== "slices") {
        continue;
      }
      const beforeCount = entry.slices.length;
      if (beforeCount <= this.options.maxSlicesPerFile) {
        continue;
      }

      const mergedSlices = mergeClosestSlices(
        entry.slices,
        this.options.maxSlicesPerFile,
      );
      this.entries.set(path, {
        ...entry,
        slices: mergedSlices,
      });
      actions.push({
        type: "merge_slices",
        path,
        reason: "max_slices_per_file",
        beforeCount,
        afterCount: mergedSlices.length,
      });
    }

    const dropOrder = [...this.entries.values()].sort(compareEntriesForConstraintDrop);
    while (this.entries.size > this.options.maxFiles) {
      const candidate = dropOrder.shift();
      if (!candidate) {
        break;
      }
      if (!this.entries.has(candidate.path)) {
        continue;
      }
      this.entries.delete(candidate.path);
      actions.push({
        type: "drop",
        path: candidate.path,
        reason: "max_files",
      });
    }

    return {
      actions,
      entries: this.getAll(),
    };
  }

  remove(path: string): boolean {
    return this.entries.delete(path);
  }

  get(path: string): ManagedSelectionEntry | undefined {
    const entry = this.entries.get(path);
    return entry ? cloneManagedEntry(entry) : undefined;
  }

  getAll(): ManagedSelectionEntry[] {
    return [...this.entries.values()]
      .sort(compareEntriesByPriority)
      .map((entry) => cloneManagedEntry(entry));
  }

  clear(): void {
    this.entries.clear();
  }

  toSummary(): SelectionSummary {
    const sortedEntries = this.getAll();
    const byMode: Record<SelectionMode, number> = {
      full: 0,
      slices: 0,
      codemap_only: 0,
    };
    const byPriority: Record<SelectionPriority, number> = {
      core: 0,
      support: 0,
      ref: 0,
    };

    for (const entry of sortedEntries) {
      byMode[entry.mode] += 1;
      byPriority[entry.priority] += 1;
    }

    return {
      totalFiles: sortedEntries.length,
      byMode,
      byPriority,
      entries: sortedEntries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        priority: entry.priority,
        priorityScore: entry.priorityScore,
      })),
    };
  }

  toManifest(): SelectionManifest {
    return {
      constraints: {
        maxFiles: this.options.maxFiles,
        maxFullFiles: this.options.maxFullFiles,
        maxSlicesPerFile: this.options.maxSlicesPerFile,
        maxFileBytes: this.options.maxFileBytes,
        neverInclude: [...this.options.neverInclude],
        excludeBinary: this.options.excludeBinary,
      },
      entries: this.getAll(),
    };
  }
}
