import { basename, dirname, extname } from "node:path";
import { stableSort } from "../utils/deterministic";

const DEFAULT_CHANGED_FILE_BOOST = 180;
const DEFAULT_REVIEW_MODE_CHANGED_FILE_BOOST = 260;
const DEFAULT_IMPORTER_BOOST = 90;
const DEFAULT_MATCHED_TEST_BOOST = 75;
const DEFAULT_REVIEW_LARGE_FILE_THRESHOLD_BYTES = 80_000;
const DEFAULT_TEST_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
];

export interface DiscoveryFileRef {
  path: string;
  size?: number;
}

export interface GitDiscoveryBiasOptions {
  changedPaths: readonly string[];
  reviewMode?: boolean;
  changedFileBoost?: number;
  reviewModeChangedFileBoost?: number;
  importerBoost?: number;
  matchedTestBoost?: number;
  reviewLargeFileThresholdBytes?: number;
}

export interface GitDiscoveryBias {
  path: string;
  totalBoost: number;
  changedFileBoost: number;
  importerBoost: number;
  matchedTestBoost: number;
  reasons: string[];
  reviewModeSuggestedMode?: "full" | "slices";
}

interface MutableBias {
  path: string;
  changedFileBoost: number;
  importerBoost: number;
  matchedTestBoost: number;
  reasons: Set<string>;
  reviewModeSuggestedMode?: "full" | "slices";
}

function normalizePath(pathValue: string): string {
  const posix = pathValue.replace(/\\/g, "/").trim();
  const withoutPrefix = posix.startsWith("./") ? posix.slice(2) : posix;
  return withoutPrefix.replace(/^\/+/, "");
}

function readNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function isLikelyTestPath(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  if (
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  ) {
    return true;
  }
  return /\.test\.[a-z0-9]+$/.test(lower) || /\.spec\.[a-z0-9]+$/.test(lower);
}

function stemWithoutExtension(pathValue: string): string {
  const extension = extname(pathValue);
  if (!extension) {
    return pathValue;
  }
  return pathValue.slice(0, -extension.length);
}

function buildChangedPathSet(changedPaths: readonly string[]): string[] {
  const normalized = [...new Set(changedPaths.map((path) => normalizePath(path)).filter((path) => path.length > 0))];
  return stableSort(normalized, (left, right) => left.localeCompare(right));
}

function collectCandidateTestPaths(changedPath: string): string[] {
  const changedExtension = extname(changedPath).toLowerCase();
  const stem = stemWithoutExtension(changedPath);
  const baseName = basename(stem);
  const directory = dirname(changedPath);
  const relativeStem = stem.startsWith("src/") ? stem.slice("src/".length) : stem;
  const testExtensions = changedExtension
    ? [changedExtension, ...DEFAULT_TEST_EXTENSIONS.filter((ext) => ext !== changedExtension)]
    : [...DEFAULT_TEST_EXTENSIONS];

  const candidates = new Set<string>();
  for (const extension of testExtensions) {
    candidates.add(`test/${relativeStem}.test${extension}`);
    candidates.add(`tests/${relativeStem}.test${extension}`);
    candidates.add(`test/${relativeStem}.spec${extension}`);
    candidates.add(`tests/${relativeStem}.spec${extension}`);
    candidates.add(`${stem}.test${extension}`);
    candidates.add(`${stem}.spec${extension}`);
    candidates.add(`${directory}/__tests__/${baseName}.test${extension}`);
    candidates.add(`${directory}/__tests__/${baseName}.spec${extension}`);
  }

  return stableSort(
    [...candidates].map((candidate) => normalizePath(candidate)),
    (left, right) => left.localeCompare(right),
  );
}

function createEmptyBias(path: string): MutableBias {
  return {
    path,
    changedFileBoost: 0,
    importerBoost: 0,
    matchedTestBoost: 0,
    reasons: new Set<string>(),
    reviewModeSuggestedMode: undefined,
  };
}

function getOrCreateBias(
  biasByPath: Map<string, MutableBias>,
  path: string,
): MutableBias {
  const existing = biasByPath.get(path);
  if (existing) {
    return existing;
  }
  const created = createEmptyBias(path);
  biasByPath.set(path, created);
  return created;
}

function applyChangedFileBias(
  biasByPath: Map<string, MutableBias>,
  fileByPath: Map<string, DiscoveryFileRef>,
  changedPaths: readonly string[],
  options: GitDiscoveryBiasOptions,
): void {
  const changedFileBoost = readNonNegativeNumber(
    options.changedFileBoost,
    DEFAULT_CHANGED_FILE_BOOST,
  );
  const reviewModeChangedBoost = readNonNegativeNumber(
    options.reviewModeChangedFileBoost,
    DEFAULT_REVIEW_MODE_CHANGED_FILE_BOOST,
  );
  const reviewLargeFileThresholdBytes = readNonNegativeNumber(
    options.reviewLargeFileThresholdBytes,
    DEFAULT_REVIEW_LARGE_FILE_THRESHOLD_BYTES,
  );

  for (const changedPath of changedPaths) {
    const changedFile = fileByPath.get(changedPath);
    if (!changedFile) {
      continue;
    }

    const boost = options.reviewMode ? reviewModeChangedBoost : changedFileBoost;
    if (boost <= 0) {
      continue;
    }

    const entry = getOrCreateBias(biasByPath, changedPath);
    entry.changedFileBoost += boost;
    entry.reasons.add("changed_file");
    if (options.reviewMode) {
      const size = changedFile.size ?? 0;
      entry.reviewModeSuggestedMode =
        size > reviewLargeFileThresholdBytes ? "slices" : "full";
      entry.reasons.add("review_mode_auto_select");
    }
  }
}

function applyImporterBias(
  biasByPath: Map<string, MutableBias>,
  importsBySource: ReadonlyMap<string, readonly string[]>,
  changedPathSet: ReadonlySet<string>,
  options: GitDiscoveryBiasOptions,
): void {
  const importerBoost = readNonNegativeNumber(
    options.importerBoost,
    DEFAULT_IMPORTER_BOOST,
  );
  if (importerBoost <= 0) {
    return;
  }

  const sourcePaths = stableSort(
    [...importsBySource.keys()].map((path) => normalizePath(path)),
    (left, right) => left.localeCompare(right),
  );
  for (const sourcePath of sourcePaths) {
    const targets = importsBySource.get(sourcePath) ?? [];
    const normalizedTargets = stableSort(
      targets.map((target) => normalizePath(target)),
      (left, right) => left.localeCompare(right),
    );
    const importsChangedFile = normalizedTargets.some((target) =>
      changedPathSet.has(target),
    );
    if (!importsChangedFile) {
      continue;
    }

    const entry = getOrCreateBias(biasByPath, sourcePath);
    entry.importerBoost += importerBoost;
    entry.reasons.add("imports_changed_file");
  }
}

function applyMatchedTestBias(
  biasByPath: Map<string, MutableBias>,
  knownPaths: ReadonlySet<string>,
  changedPaths: readonly string[],
  options: GitDiscoveryBiasOptions,
): void {
  const matchedTestBoost = readNonNegativeNumber(
    options.matchedTestBoost,
    DEFAULT_MATCHED_TEST_BOOST,
  );
  if (matchedTestBoost <= 0) {
    return;
  }

  const knownTestPaths = stableSort(
    [...knownPaths].filter((path) => isLikelyTestPath(path)),
    (left, right) => left.localeCompare(right),
  );

  for (const changedPath of changedPaths) {
    const changedStem = basename(stemWithoutExtension(changedPath)).toLowerCase();
    const changedDirTokens = dirname(changedPath)
      .toLowerCase()
      .split("/")
      .filter((token) => token.length > 1 && token !== "src");

    const matchedTests = new Set<string>();
    for (const candidate of collectCandidateTestPaths(changedPath)) {
      if (knownPaths.has(candidate)) {
        matchedTests.add(candidate);
      }
    }

    if (matchedTests.size === 0) {
      for (const testPath of knownTestPaths) {
        const lowerPath = testPath.toLowerCase();
        if (!lowerPath.includes(changedStem)) {
          continue;
        }
        if (
          changedDirTokens.length > 0 &&
          !changedDirTokens.some((token) => lowerPath.includes(token))
        ) {
          continue;
        }
        matchedTests.add(testPath);
      }
    }

    for (const testPath of stableSort(
      [...matchedTests],
      (left, right) => left.localeCompare(right),
    )) {
      const entry = getOrCreateBias(biasByPath, testPath);
      entry.matchedTestBoost += matchedTestBoost;
      entry.reasons.add("tests_changed_module");
    }
  }
}

export function computeGitDiscoveryBias(
  files: readonly DiscoveryFileRef[],
  importsBySource: ReadonlyMap<string, readonly string[]>,
  options: GitDiscoveryBiasOptions,
): Map<string, GitDiscoveryBias> {
  const normalizedFiles = stableSort(
    files
      .map((file) => ({
        path: normalizePath(file.path),
        size: file.size,
      }))
      .filter((file) => file.path.length > 0),
    (left, right) => left.path.localeCompare(right.path),
  );

  const fileByPath = new Map<string, DiscoveryFileRef>();
  for (const file of normalizedFiles) {
    fileByPath.set(file.path, file);
  }
  const knownPathSet = new Set(fileByPath.keys());
  const changedPaths = buildChangedPathSet(options.changedPaths);
  const changedPathSet = new Set(changedPaths);
  const mutableBiasByPath = new Map<string, MutableBias>();

  if (changedPaths.length === 0 || normalizedFiles.length === 0) {
    return new Map();
  }

  applyChangedFileBias(mutableBiasByPath, fileByPath, changedPaths, options);
  applyImporterBias(mutableBiasByPath, importsBySource, changedPathSet, options);
  applyMatchedTestBias(mutableBiasByPath, knownPathSet, changedPaths, options);

  const result = new Map<string, GitDiscoveryBias>();
  const orderedPaths = stableSort(
    [...mutableBiasByPath.keys()],
    (left, right) => left.localeCompare(right),
  );
  for (const path of orderedPaths) {
    const entry = mutableBiasByPath.get(path);
    if (!entry) {
      continue;
    }
    const totalBoost =
      entry.changedFileBoost + entry.importerBoost + entry.matchedTestBoost;
    if (totalBoost <= 0) {
      continue;
    }
    result.set(path, {
      path,
      totalBoost,
      changedFileBoost: entry.changedFileBoost,
      importerBoost: entry.importerBoost,
      matchedTestBoost: entry.matchedTestBoost,
      reasons: stableSort([...entry.reasons], (left, right) =>
        left.localeCompare(right),
      ),
      reviewModeSuggestedMode: entry.reviewModeSuggestedMode,
    });
  }

  return result;
}
