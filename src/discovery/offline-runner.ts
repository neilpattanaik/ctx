import type { Database } from "bun:sqlite";
import type {
  DataFlowNote,
  DiscoveryResult,
  FileEntry,
  PathNote,
  SelectionEntry,
  SymbolInfo,
} from "../types";
import { constructAstAwareSlices } from "../selection";
import { stableSort } from "../utils/deterministic";
import { detectLikelyEntrypoints, type EntrypointCandidate } from "./entrypoints";
import { rankFilesFromIndex, type RankedFileScore } from "./offline-ranking";
import { extractTaskTerms } from "./task-terms";

const DEFAULT_MAX_FULL_FILES = 8;
const DEFAULT_MAX_SLICE_FILES = 15;
const DEFAULT_MAX_CODEMAP_ONLY_FILES = 30;
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_SLICE_CONTEXT_LINES = 30;
const DEFAULT_MAX_SLICES_PER_FILE = 4;
const DEFAULT_MAX_ENTRYPOINT_SUMMARY = 8;
const DEFAULT_MAX_KEY_MODULE_SUMMARY = 12;
const DEFAULT_MAX_DATA_FLOWS = 20;

interface ImportEdgeRow {
  source_path: string;
  target_path: string;
}

export interface OfflineDiscoveryRunnerOptions {
  db: Database;
  task: string;
  repoFiles: readonly FileEntry[];
  readFileText?: (path: string) => string | null | undefined;
  symbolsByPath?: Record<string, readonly SymbolInfo[]>;
  gitChangedPaths?: readonly string[];
  reviewMode?: boolean;
  maxFullFiles?: number;
  maxSliceFiles?: number;
  maxCodemapOnlyFiles?: number;
  maxFileBytes?: number;
  maxSlicesPerFile?: number;
  sliceFallbackContextLines?: number;
  maxEntrypointsInSummary?: number;
  maxKeyModulesInSummary?: number;
  maxDataFlows?: number;
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isTestPath(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  return (
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.js")
  );
}

function buildEntrypointMap(
  candidates: readonly EntrypointCandidate[],
): Map<string, EntrypointCandidate> {
  const map = new Map<string, EntrypointCandidate>();
  for (const candidate of candidates) {
    map.set(normalizePath(candidate.path), candidate);
  }
  return map;
}

function buildSelectionRationale(score: RankedFileScore): string {
  const parts = [
    `offline score=${score.score}`,
    `content_hits=${score.contentHitCount}`,
    `path_hits=${score.pathHitCount}`,
  ];
  if (score.importProximityBoost > 0) {
    parts.push(`import_boost=${score.importProximityBoost}`);
  }
  if (score.entrypointBoost > 0) {
    parts.push(`entrypoint_boost=${score.entrypointBoost}`);
  }
  if (score.gitBiasBoost > 0) {
    parts.push(`git_bias=${score.gitBiasBoost}`);
  }
  return parts.join(", ");
}

function chooseMode(
  score: RankedFileScore,
  file: FileEntry | undefined,
  counts: { full: number; slices: number; codemap: number },
  limits: { full: number; slices: number; codemap: number; maxFileBytes: number },
): SelectionEntry["mode"] | null {
  const fileSize = file?.size ?? 0;
  const canBeFull = fileSize <= limits.maxFileBytes;

  if (score.reviewModeSuggestedMode === "full" && canBeFull && counts.full < limits.full) {
    return "full";
  }
  if (score.reviewModeSuggestedMode === "slices" && counts.slices < limits.slices) {
    return "slices";
  }

  if (counts.full < limits.full && canBeFull) {
    return "full";
  }
  if (counts.slices < limits.slices) {
    return "slices";
  }
  if (counts.codemap < limits.codemap) {
    return "codemap_only";
  }
  return null;
}

function loadDataFlowNotes(
  db: Database,
  selectedPathSet: ReadonlySet<string>,
  maxDataFlows: number,
): DataFlowNote[] {
  const rows = db
    .query<ImportEdgeRow>(
      `SELECT source.path AS source_path, imports.imported_path AS target_path
       FROM imports
       JOIN files AS source ON source.id = imports.file_id
       ORDER BY source.path ASC, imports.imported_path ASC, imports.id ASC;`,
    )
    .all();

  const notes: DataFlowNote[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const source = normalizePath(row.source_path);
    const target = normalizePath(row.target_path);
    if (!selectedPathSet.has(source) || !selectedPathSet.has(target)) {
      continue;
    }
    if (source === target) {
      continue;
    }
    const edge = `${source} -> ${target}`;
    if (seen.has(edge)) {
      continue;
    }
    seen.add(edge);
    notes.push({
      name: edge,
      notes: "import relationship between selected files",
    });
    if (notes.length >= maxDataFlows) {
      break;
    }
  }

  return notes;
}

function toPathNote(path: string, notes: string): PathNote {
  return { path, notes };
}

export function runOfflineDiscovery(
  options: OfflineDiscoveryRunnerOptions,
): DiscoveryResult {
  const maxFullFiles = readPositiveInteger(options.maxFullFiles, DEFAULT_MAX_FULL_FILES);
  const maxSliceFiles = readPositiveInteger(
    options.maxSliceFiles,
    DEFAULT_MAX_SLICE_FILES,
  );
  const maxCodemapOnlyFiles = readPositiveInteger(
    options.maxCodemapOnlyFiles,
    DEFAULT_MAX_CODEMAP_ONLY_FILES,
  );
  const maxFileBytes = readPositiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxSlicesPerFile = readPositiveInteger(
    options.maxSlicesPerFile,
    DEFAULT_MAX_SLICES_PER_FILE,
  );
  const sliceContextLines = readPositiveInteger(
    options.sliceFallbackContextLines,
    DEFAULT_SLICE_CONTEXT_LINES,
  );
  const maxEntrypoints = readPositiveInteger(
    options.maxEntrypointsInSummary,
    DEFAULT_MAX_ENTRYPOINT_SUMMARY,
  );
  const maxKeyModules = readPositiveInteger(
    options.maxKeyModulesInSummary,
    DEFAULT_MAX_KEY_MODULE_SUMMARY,
  );
  const maxDataFlows = readPositiveInteger(options.maxDataFlows, DEFAULT_MAX_DATA_FLOWS);
  const maxRankedResults = maxFullFiles + maxSliceFiles + maxCodemapOnlyFiles;

  const normalizedFiles = stableSort(
    options.repoFiles.map((file) => ({
      ...file,
      path: normalizePath(file.path),
    })),
    (left, right) => left.path.localeCompare(right.path),
  );
  const fileByPath = new Map(normalizedFiles.map((file) => [file.path, file] as const));

  const taskTerms = extractTaskTerms(options.task);
  const entrypointCandidates = detectLikelyEntrypoints(
    normalizedFiles.map((file) => file.path),
    {
      readFileText: options.readFileText,
      maxResults: Math.max(maxEntrypoints * 2, 64),
    },
  );
  const entrypointPathSet = new Set(
    entrypointCandidates.map((candidate) => normalizePath(candidate.path)),
  );
  const entrypointByPath = buildEntrypointMap(entrypointCandidates);

  const ranked = rankFilesFromIndex(options.db, taskTerms, {
    maxResults: Math.max(maxRankedResults * 2, 64),
    entrypointPaths: [...entrypointPathSet],
    gitChangedPaths: options.gitChangedPaths,
    reviewMode: options.reviewMode,
  });

  const selection: SelectionEntry[] = [];
  const selectedPathSet = new Set<string>();
  const counts = { full: 0, slices: 0, codemap: 0 };

  for (const rankedFile of ranked) {
    const path = normalizePath(rankedFile.path);
    if (selectedPathSet.has(path)) {
      continue;
    }
    const file = fileByPath.get(path);
    const mode = chooseMode(rankedFile, file, counts, {
      full: maxFullFiles,
      slices: maxSliceFiles,
      codemap: maxCodemapOnlyFiles,
      maxFileBytes,
    });
    if (!mode) {
      break;
    }

    const priority =
      mode === "full" ? "core" : mode === "slices" ? "support" : "ref";
    const rationale = buildSelectionRationale(rankedFile);

    if (mode === "slices") {
      const content = options.readFileText?.(path) ?? "";
      const slices = constructAstAwareSlices({
        path,
        content,
        taskTerms: taskTerms.searchTerms,
        symbols: options.symbolsByPath?.[path],
        fallbackContextLines: sliceContextLines,
        maxSlicesPerFile,
      });
      selection.push({
        path,
        mode,
        priority,
        rationale,
        slices,
      });
      counts.slices += 1;
    } else if (mode === "full") {
      selection.push({
        path,
        mode,
        priority,
        rationale,
      });
      counts.full += 1;
    } else {
      selection.push({
        path,
        mode,
        priority,
        rationale,
      });
      counts.codemap += 1;
    }

    selectedPathSet.add(path);
    if (selection.length >= maxRankedResults) {
      break;
    }
  }

  const rankedByPath = new Map(
    ranked.map((item) => [normalizePath(item.path), item] as const),
  );
  const selectedEntrypoints = selection
    .map((entry) => entry.path)
    .filter((path) => entrypointPathSet.has(path))
    .slice(0, maxEntrypoints)
    .map((path) =>
      toPathNote(
        path,
        `entrypoint score=${rankedByPath.get(path)?.score ?? 0}; heuristics=${(entrypointByPath.get(path)?.heuristics ?? [])
          .map((item) => item.heuristic)
          .join(", ")}`,
      ),
    );

  const keyModules = selection
    .map((entry) => entry.path)
    .filter((path) => !entrypointPathSet.has(path))
    .slice(0, maxKeyModules)
    .map((path) =>
      toPathNote(path, `ranked score=${rankedByPath.get(path)?.score ?? 0}`),
    );

  const configKnobs = taskTerms.configKeys.map((key) => ({
    key,
    where: "task terms",
    notes: "mentioned in task; validate usage in selected files",
  }));

  const tests = selection
    .map((entry) => entry.path)
    .filter((path) => isTestPath(path))
    .map((path) => toPathNote(path, "selected test context"));

  return {
    openQuestions: [],
    handoffSummary: {
      entrypoints: selectedEntrypoints,
      keyModules,
      dataFlows: loadDataFlowNotes(options.db, selectedPathSet, maxDataFlows),
      configKnobs,
      tests: stableSort(tests, (left, right) => left.path.localeCompare(right.path)),
    },
    selection,
  };
}
