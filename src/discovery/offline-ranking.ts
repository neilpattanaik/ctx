import type { Database } from "bun:sqlite";
import { stableSort } from "../utils/deterministic";
import { computeGitDiscoveryBias } from "./git-bias";
import type { ExtractedTaskTerms } from "./task-terms";

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_PATH_TERM_WEIGHT = 14;
const DEFAULT_BREADTH_BONUS_PER_TERM = 6;
const DEFAULT_IMPORT_PROXIMITY_FACTOR = 0.2;
const DEFAULT_ENTRYPOINT_BOOST = 40;

const SEARCH_TERM_WEIGHT = 6;
const IDENTIFIER_TERM_WEIGHT = 10;
const CONFIG_KEY_TERM_WEIGHT = 8;
const ENDPOINT_TERM_WEIGHT = 7;
const PATH_CONTENT_TERM_WEIGHT = 9;

interface IndexedFileRow {
  id: number;
  path: string;
  size: number;
}

interface ImportEdgeRow {
  file_id: number;
  imported_path: string;
}

interface SearchTextRow {
  file_id: number;
  name: string;
  signature: string;
}

interface ImportSearchRow {
  file_id: number;
  imported_path: string;
  imported_names: string;
}

interface WorkingScore {
  fileId: number;
  path: string;
  rawScore: number;
  matchedTerms: Set<string>;
  contentHitCount: number;
  pathHitCount: number;
  entrypointBoost: number;
}

interface ImportGraph {
  bySourceId: Map<number, number[]>;
  bySourcePath: Map<string, string[]>;
}

export interface OfflineFileRankingOptions {
  maxResults?: number;
  pathTermWeight?: number;
  breadthBonusPerTerm?: number;
  importProximityFactor?: number;
  entrypointPaths?: readonly string[];
  entrypointBoost?: number;
  gitChangedPaths?: readonly string[];
  reviewMode?: boolean;
}

export interface RankedFileScore {
  path: string;
  score: number;
  rawScore: number;
  matchedTerms: string[];
  matchedTermCount: number;
  contentHitCount: number;
  pathHitCount: number;
  importProximityBoost: number;
  entrypointBoost: number;
  gitBiasBoost: number;
  gitBiasReasons: string[];
  reviewModeSuggestedMode?: "full" | "slices";
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function readNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function splitIntoTerms(value: string): string[] {
  const withCamelSplit = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return withCamelSplit
    .split(/[^A-Za-z0-9]+/g)
    .map((fragment) => fragment.trim().toLowerCase())
    .filter((fragment) => fragment.length >= 2);
}

function addWeightedTerm(
  target: Map<string, number>,
  rawTerm: string,
  weight: number,
): void {
  const term = rawTerm.trim().toLowerCase();
  if (term.length < 2) {
    return;
  }
  target.set(term, (target.get(term) ?? 0) + weight);
}

function addTermsFromValues(
  target: Map<string, number>,
  values: readonly string[],
  weight: number,
  includeRawToken: boolean,
): void {
  for (const value of values) {
    if (includeRawToken) {
      addWeightedTerm(target, value, weight);
    }
    for (const term of splitIntoTerms(value)) {
      addWeightedTerm(target, term, weight);
    }
  }
}

function buildContentTermWeights(taskTerms: ExtractedTaskTerms): Map<string, number> {
  const weights = new Map<string, number>();

  addTermsFromValues(weights, taskTerms.searchTerms, SEARCH_TERM_WEIGHT, true);
  addTermsFromValues(weights, taskTerms.identifiers, IDENTIFIER_TERM_WEIGHT, true);
  addTermsFromValues(weights, taskTerms.configKeys, CONFIG_KEY_TERM_WEIGHT, true);
  addTermsFromValues(weights, taskTerms.endpoints, ENDPOINT_TERM_WEIGHT, false);
  addTermsFromValues(weights, taskTerms.paths, PATH_CONTENT_TERM_WEIGHT, false);

  return weights;
}

function buildPathTermSet(taskTerms: ExtractedTaskTerms): Set<string> {
  const terms = new Set<string>();
  for (const pathValue of taskTerms.paths) {
    for (const token of splitIntoTerms(pathValue)) {
      if (token.length >= 2) {
        terms.add(token);
      }
    }
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  while (startIndex < haystack.length) {
    const foundIndex = haystack.indexOf(needle, startIndex);
    if (foundIndex < 0) {
      break;
    }
    count += 1;
    startIndex = foundIndex + needle.length;
  }
  return count;
}

function tokenizePath(pathValue: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of splitIntoTerms(pathValue)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function parseImportedNames(importedNames: string): string[] {
  try {
    const parsed = JSON.parse(importedNames) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function appendSearchText(
  textByFileId: Map<number, string[]>,
  fileId: number,
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  const current = textByFileId.get(fileId) ?? [];
  current.push(trimmed.toLowerCase());
  textByFileId.set(fileId, current);
}

function loadIndexedFiles(db: Database): IndexedFileRow[] {
  return db
    .query<IndexedFileRow>(
      `SELECT id, path, size
       FROM files
       ORDER BY path ASC;`,
    )
    .all();
}

function loadSearchTextByFile(
  db: Database,
  files: readonly IndexedFileRow[],
): Map<number, string> {
  const textParts = new Map<number, string[]>();

  for (const file of files) {
    appendSearchText(textParts, file.id, file.path);
  }

  const symbols = db
    .query<SearchTextRow>(
      `SELECT file_id, name, signature
       FROM symbols
       ORDER BY file_id ASC, line_number ASC, id ASC;`,
    )
    .all();
  for (const symbol of symbols) {
    appendSearchText(textParts, symbol.file_id, symbol.name);
    appendSearchText(textParts, symbol.file_id, symbol.signature);
  }

  const imports = db
    .query<ImportSearchRow>(
      `SELECT file_id, imported_path, imported_names
       FROM imports
       ORDER BY file_id ASC, imported_path ASC, id ASC;`,
    )
    .all();
  for (const entry of imports) {
    appendSearchText(textParts, entry.file_id, entry.imported_path);
    for (const importedName of parseImportedNames(entry.imported_names)) {
      appendSearchText(textParts, entry.file_id, importedName);
    }
  }

  const textByFileId = new Map<number, string>();
  for (const file of files) {
    const parts = textParts.get(file.id) ?? [];
    textByFileId.set(file.id, parts.join("\n"));
  }
  return textByFileId;
}

function loadImportGraph(
  db: Database,
  files: readonly IndexedFileRow[],
): ImportGraph {
  const pathToId = new Map<string, number>();
  const idToPath = new Map<number, string>();
  for (const file of files) {
    pathToId.set(file.path, file.id);
    idToPath.set(file.id, file.path);
  }

  const rows = db
    .query<ImportEdgeRow>(
      `SELECT file_id, imported_path
       FROM imports
       ORDER BY file_id ASC, imported_path ASC, id ASC;`,
    )
    .all();

  const edgeSetsById = new Map<number, Set<number>>();
  const edgeSetsByPath = new Map<string, Set<string>>();
  for (const row of rows) {
    const targetFileId = pathToId.get(row.imported_path);
    if (targetFileId === undefined || targetFileId === row.file_id) {
      continue;
    }
    const targets = edgeSetsById.get(row.file_id) ?? new Set<number>();
    targets.add(targetFileId);
    edgeSetsById.set(row.file_id, targets);

    const sourcePath = idToPath.get(row.file_id);
    const targetPath = idToPath.get(targetFileId);
    if (!sourcePath || !targetPath) {
      continue;
    }
    const pathTargets = edgeSetsByPath.get(sourcePath) ?? new Set<string>();
    pathTargets.add(targetPath);
    edgeSetsByPath.set(sourcePath, pathTargets);
  }

  const bySourceId = new Map<number, number[]>();
  for (const [sourceId, targetIds] of edgeSetsById) {
    const sortedTargets = stableSort(
      [...targetIds],
      (left, right) =>
        (idToPath.get(left) ?? "").localeCompare(idToPath.get(right) ?? ""),
    );
    bySourceId.set(sourceId, sortedTargets);
  }

  const bySourcePath = new Map<string, string[]>();
  for (const [sourcePath, targetPaths] of edgeSetsByPath) {
    bySourcePath.set(
      sourcePath,
      stableSort([...targetPaths], (left, right) => left.localeCompare(right)),
    );
  }

  return {
    bySourceId,
    bySourcePath,
  };
}

function normalizePathSet(paths: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const pathValue of paths) {
    const value = pathValue.trim().toLowerCase();
    if (value.length > 0) {
      normalized.add(value);
    }
  }
  return normalized;
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function toNormalizedScore(rawScore: number, maxRawScore: number): number {
  if (maxRawScore <= 0) {
    return 0;
  }

  const scaled = Math.round((rawScore / maxRawScore) * 1000);
  if (scaled <= 0) {
    return 1;
  }
  if (scaled > 1000) {
    return 1000;
  }
  return scaled;
}

export function rankFilesFromIndex(
  db: Database,
  taskTerms: ExtractedTaskTerms,
  options: OfflineFileRankingOptions = {},
): RankedFileScore[] {
  const maxResults = readPositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
  const pathTermWeight = readNonNegativeNumber(
    options.pathTermWeight,
    DEFAULT_PATH_TERM_WEIGHT,
  );
  const breadthBonusPerTerm = readNonNegativeNumber(
    options.breadthBonusPerTerm,
    DEFAULT_BREADTH_BONUS_PER_TERM,
  );
  const importProximityFactor = readNonNegativeNumber(
    options.importProximityFactor,
    DEFAULT_IMPORT_PROXIMITY_FACTOR,
  );
  const entrypointBoost = readNonNegativeNumber(
    options.entrypointBoost,
    DEFAULT_ENTRYPOINT_BOOST,
  );

  const files = loadIndexedFiles(db);
  if (files.length === 0) {
    return [];
  }

  const contentTerms = buildContentTermWeights(taskTerms);
  const orderedContentTerms = stableSort(
    [...contentTerms.entries()],
    (left, right) => left[0].localeCompare(right[0]),
  );
  const pathTerms = stableSort(
    [...buildPathTermSet(taskTerms)],
    (left, right) => left.localeCompare(right),
  );
  const entrypointPathSet = normalizePathSet(options.entrypointPaths ?? []);
  const searchTextByFile = loadSearchTextByFile(db, files);
  const baseScores = new Map<number, WorkingScore>();

  for (const file of files) {
    const matchedTerms = new Set<string>();
    const searchText = searchTextByFile.get(file.id) ?? file.path.toLowerCase();

    let rawScore = 0;
    let contentHitCount = 0;
    for (const [term, weight] of orderedContentTerms) {
      const frequency = countOccurrences(searchText, term);
      if (frequency <= 0) {
        continue;
      }
      contentHitCount += frequency;
      rawScore += frequency * weight;
      matchedTerms.add(term);
    }

    const pathTokenCounts = tokenizePath(file.path);
    let pathHitCount = 0;
    if (pathTermWeight > 0) {
      for (const pathTerm of pathTerms) {
        const frequency = pathTokenCounts.get(pathTerm) ?? 0;
        if (frequency <= 0) {
          continue;
        }
        pathHitCount += frequency;
        rawScore += frequency * pathTermWeight;
        matchedTerms.add(pathTerm);
      }
    }

    if (matchedTerms.size > 1 && breadthBonusPerTerm > 0) {
      rawScore += matchedTerms.size * breadthBonusPerTerm;
    }

    let appliedEntrypointBoost = 0;
    if (entrypointBoost > 0 && entrypointPathSet.has(file.path.toLowerCase())) {
      appliedEntrypointBoost = entrypointBoost;
      rawScore += entrypointBoost;
    }

    baseScores.set(file.id, {
      fileId: file.id,
      path: file.path,
      rawScore: roundScore(rawScore),
      matchedTerms,
      contentHitCount,
      pathHitCount,
      entrypointBoost: appliedEntrypointBoost,
    });
  }

  const importGraph = loadImportGraph(db, files);
  const importBoostByFileId = new Map<number, number>();
  if (importProximityFactor > 0) {
    for (const file of files) {
      const sourceScore = baseScores.get(file.id);
      if (!sourceScore || sourceScore.rawScore <= 0) {
        continue;
      }
      const targets = importGraph.bySourceId.get(file.id) ?? [];
      if (targets.length === 0) {
        continue;
      }

      const perTargetBoost =
        (sourceScore.rawScore * importProximityFactor) / targets.length;
      for (const targetFileId of targets) {
        const current = importBoostByFileId.get(targetFileId) ?? 0;
        importBoostByFileId.set(
          targetFileId,
          roundScore(current + perTargetBoost),
        );
      }
    }
  }

  const gitBiasByPath =
    options.gitChangedPaths && options.gitChangedPaths.length > 0
      ? computeGitDiscoveryBias(
          files.map((file) => ({
            path: file.path,
            size: file.size,
          })),
          importGraph.bySourcePath,
          {
            changedPaths: options.gitChangedPaths,
            reviewMode: options.reviewMode ?? false,
          },
        )
      : new Map();

  const scoredFiles: RankedFileScore[] = [];
  for (const file of files) {
    const baseScore = baseScores.get(file.id);
    if (!baseScore) {
      continue;
    }

    const importBoost = importBoostByFileId.get(file.id) ?? 0;
    const gitBias = gitBiasByPath.get(file.path);
    const gitBiasBoost = gitBias?.totalBoost ?? 0;
    const finalRawScore = roundScore(
      baseScore.rawScore + importBoost + gitBiasBoost,
    );
    if (finalRawScore <= 0) {
      continue;
    }

    const matchedTerms = stableSort(
      [...baseScore.matchedTerms],
      (left, right) => left.localeCompare(right),
    );
    scoredFiles.push({
      path: baseScore.path,
      score: 0,
      rawScore: finalRawScore,
      matchedTerms,
      matchedTermCount: matchedTerms.length,
      contentHitCount: baseScore.contentHitCount,
      pathHitCount: baseScore.pathHitCount,
      importProximityBoost: roundScore(importBoost),
      entrypointBoost: baseScore.entrypointBoost,
      gitBiasBoost,
      gitBiasReasons: gitBias?.reasons ?? [],
      reviewModeSuggestedMode: gitBias?.reviewModeSuggestedMode,
    });
  }

  if (scoredFiles.length === 0) {
    return [];
  }

  const maxRawScore = Math.max(...scoredFiles.map((entry) => entry.rawScore));
  const normalized = scoredFiles.map((entry) => ({
    ...entry,
    score: toNormalizedScore(entry.rawScore, maxRawScore),
  }));

  return stableSort(normalized, (left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.rawScore !== right.rawScore) {
      return right.rawScore - left.rawScore;
    }
    return left.path.localeCompare(right.path);
  }).slice(0, maxResults);
}
