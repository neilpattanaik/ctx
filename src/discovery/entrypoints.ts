import { basename, dirname, extname, join } from "node:path";
import { stableSort } from "../utils/deterministic";
import type { FileEntry } from "../types";

const DEFAULT_MAX_RESULTS = 64;
const RESOLUTION_EXTENSIONS = [
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

const PACKAGE_MAIN_CONFIDENCE = 120;
const PACKAGE_BIN_CONFIDENCE = 110;
const PACKAGE_EXPORTS_CONFIDENCE = 95;
const FRAMEWORK_ENTRY_CONFIDENCE = 80;
const ROUTE_CONTROLLER_CONFIDENCE = 70;
const CLI_SHEBANG_CONFIDENCE = 100;
const CLI_BIN_DIR_CONFIDENCE = 65;
const TEST_CONFIG_CONFIDENCE = 60;
const CONFIG_ENTRY_CONFIDENCE = 55;
const PYTHON_ENTRY_CONFIDENCE = 90;
const GO_ENTRY_CONFIDENCE = 95;
const RUST_ENTRY_CONFIDENCE = 90;

const ROOT_FRAMEWORK_FILES = new Set([
  "app.ts",
  "app.js",
  "app.tsx",
  "app.jsx",
  "server.ts",
  "server.js",
  "server.tsx",
  "server.jsx",
  "main.ts",
  "main.js",
  "main.tsx",
  "main.jsx",
  "index.ts",
  "index.js",
  "index.tsx",
  "index.jsx",
]);

const ROUTE_SEGMENTS = ["routes", "controllers", "handlers", "api"];
const TEST_CONFIG_FILES = new Set([
  "jest.config.js",
  "jest.config.ts",
  "jest.config.cjs",
  "jest.config.mjs",
  "vitest.config.js",
  "vitest.config.ts",
  "vitest.config.mjs",
  "playwright.config.ts",
  "playwright.config.js",
  "cypress.config.ts",
  "cypress.config.js",
]);

const SETTINGS_FILE_NAMES = new Set([
  "settings.py",
  "settings.ts",
  "settings.js",
  "appsettings.json",
]);

type PathLike = string | Pick<FileEntry, "path">;

export type EntrypointHeuristic =
  | "package_main"
  | "package_bin"
  | "package_exports"
  | "framework_root_entry"
  | "route_controller"
  | "cli_shebang"
  | "cli_bin_dir"
  | "test_config"
  | "config_entry"
  | "python_entry"
  | "go_entry"
  | "rust_entry";

export interface EntrypointEvidence {
  heuristic: EntrypointHeuristic;
  confidence: number;
}

export interface EntrypointCandidate {
  path: string;
  score: number;
  confidence: number;
  heuristics: EntrypointEvidence[];
}

export interface EntrypointDetectionOptions {
  maxResults?: number;
  readFileText?: (path: string) => string | null | undefined;
}

interface MutableCandidate {
  path: string;
  heuristics: Map<EntrypointHeuristic, number>;
}

function normalizePath(pathValue: string): string {
  const posix = pathValue.replace(/\\/g, "/").trim();
  const withoutPrefix = posix.startsWith("./") ? posix.slice(2) : posix;
  return withoutPrefix.replace(/^\/+/, "");
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function pathFromItem(item: PathLike): string {
  if (typeof item === "string") {
    return normalizePath(item);
  }
  return normalizePath(item.path);
}

function splitSegments(pathValue: string): string[] {
  return pathValue
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

function createCandidateStore(paths: readonly string[]): Map<string, MutableCandidate> {
  const store = new Map<string, MutableCandidate>();
  for (const path of paths) {
    store.set(path, {
      path,
      heuristics: new Map<EntrypointHeuristic, number>(),
    });
  }
  return store;
}

function addEvidence(
  candidates: Map<string, MutableCandidate>,
  filePath: string,
  heuristic: EntrypointHeuristic,
  confidence: number,
): void {
  const candidate = candidates.get(filePath);
  if (!candidate) {
    return;
  }
  const existing = candidate.heuristics.get(heuristic) ?? 0;
  candidate.heuristics.set(heuristic, Math.max(existing, confidence));
}

function collectExportTargets(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    sink.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectExportTargets(item, sink);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectExportTargets(item, sink);
    }
  }
}

function resolvePackageTarget(
  packagePath: string,
  target: string,
  knownPaths: Set<string>,
): string | null {
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget.length === 0) {
    return null;
  }

  const packageDir = dirname(packagePath);
  const baseCandidate = normalizePath(join(packageDir, normalizedTarget));

  const candidates: string[] = [baseCandidate];
  if (extname(baseCandidate).length === 0) {
    for (const extension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${baseCandidate}${extension}`);
      candidates.push(`${baseCandidate}/index${extension}`);
    }
  }

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function applyPackageEntrypointHeuristics(
  candidates: Map<string, MutableCandidate>,
  knownPaths: Set<string>,
  options: EntrypointDetectionOptions,
): void {
  const readFile = options.readFileText;
  if (!readFile) {
    return;
  }

  const packageFiles = stableSort(
    [...knownPaths].filter((path) => basename(path) === "package.json"),
    (left, right) => left.localeCompare(right),
  );

  for (const packagePath of packageFiles) {
    const raw = readFile(packagePath);
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.main === "string") {
      const resolved = resolvePackageTarget(packagePath, parsed.main, knownPaths);
      if (resolved) {
        addEvidence(candidates, resolved, "package_main", PACKAGE_MAIN_CONFIDENCE);
      }
    }

    if (typeof parsed.bin === "string") {
      const resolved = resolvePackageTarget(packagePath, parsed.bin, knownPaths);
      if (resolved) {
        addEvidence(candidates, resolved, "package_bin", PACKAGE_BIN_CONFIDENCE);
      }
    } else if (parsed.bin && typeof parsed.bin === "object") {
      for (const value of Object.values(parsed.bin)) {
        if (typeof value !== "string") {
          continue;
        }
        const resolved = resolvePackageTarget(packagePath, value, knownPaths);
        if (resolved) {
          addEvidence(candidates, resolved, "package_bin", PACKAGE_BIN_CONFIDENCE);
        }
      }
    }

    const exportTargets: string[] = [];
    collectExportTargets(parsed.exports, exportTargets);
    for (const target of exportTargets) {
      const resolved = resolvePackageTarget(packagePath, target, knownPaths);
      if (resolved) {
        addEvidence(
          candidates,
          resolved,
          "package_exports",
          PACKAGE_EXPORTS_CONFIDENCE,
        );
      }
    }
  }
}

function isFrameworkEntrypoint(pathValue: string): boolean {
  const segments = splitSegments(pathValue);
  if (segments.length === 0) {
    return false;
  }

  const fileName = segments[segments.length - 1]!;
  if (!ROOT_FRAMEWORK_FILES.has(fileName)) {
    return false;
  }

  if (segments.length === 1) {
    return true;
  }

  return segments.length === 2 && segments[0] === "src";
}

function containsRouteSegment(pathValue: string): boolean {
  const segments = splitSegments(pathValue);
  return ROUTE_SEGMENTS.some((segment) => segments.includes(segment));
}

function isBinDirectoryPath(pathValue: string): boolean {
  const segments = splitSegments(pathValue);
  if (segments.length < 2) {
    return false;
  }
  return segments.includes("bin");
}

function applyPathPatternHeuristics(
  candidates: Map<string, MutableCandidate>,
  knownPaths: readonly string[],
): void {
  for (const pathValue of knownPaths) {
    const fileName = basename(pathValue).toLowerCase();
    const segments = splitSegments(pathValue);

    if (isFrameworkEntrypoint(pathValue)) {
      addEvidence(
        candidates,
        pathValue,
        "framework_root_entry",
        FRAMEWORK_ENTRY_CONFIDENCE,
      );
    }

    if (containsRouteSegment(pathValue)) {
      addEvidence(
        candidates,
        pathValue,
        "route_controller",
        ROUTE_CONTROLLER_CONFIDENCE,
      );
    }

    if (isBinDirectoryPath(pathValue)) {
      addEvidence(candidates, pathValue, "cli_bin_dir", CLI_BIN_DIR_CONFIDENCE);
    }

    if (TEST_CONFIG_FILES.has(fileName)) {
      addEvidence(candidates, pathValue, "test_config", TEST_CONFIG_CONFIDENCE);
    }

    if (
      fileName === ".env.example" ||
      segments.includes("config") ||
      SETTINGS_FILE_NAMES.has(fileName)
    ) {
      addEvidence(candidates, pathValue, "config_entry", CONFIG_ENTRY_CONFIDENCE);
    }

    if (
      fileName === "setup.py" ||
      fileName === "__main__.py" ||
      fileName === "manage.py"
    ) {
      addEvidence(candidates, pathValue, "python_entry", PYTHON_ENTRY_CONFIDENCE);
    }

    if (
      fileName === "main.go" &&
      (segments.includes("cmd") || segments.length === 1)
    ) {
      addEvidence(candidates, pathValue, "go_entry", GO_ENTRY_CONFIDENCE);
    }

    if (
      (fileName === "main.rs" || fileName === "lib.rs") &&
      (segments.length === 1 ||
        (segments.length >= 2 && segments[segments.length - 2] === "src"))
    ) {
      addEvidence(candidates, pathValue, "rust_entry", RUST_ENTRY_CONFIDENCE);
    }
  }
}

function applyShebangHeuristic(
  candidates: Map<string, MutableCandidate>,
  knownPaths: readonly string[],
  options: EntrypointDetectionOptions,
): void {
  const readFile = options.readFileText;
  if (!readFile) {
    return;
  }

  for (const pathValue of knownPaths) {
    const raw = readFile(pathValue);
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    if (raw.startsWith("#!")) {
      addEvidence(candidates, pathValue, "cli_shebang", CLI_SHEBANG_CONFIDENCE);
    }
  }
}

export function detectLikelyEntrypoints(
  files: readonly PathLike[],
  options: EntrypointDetectionOptions = {},
): EntrypointCandidate[] {
  const normalizedPaths = stableSort(
    [...new Set(files.map((item) => pathFromItem(item)).filter((path) => path.length > 0))],
    (left, right) => left.localeCompare(right),
  );
  if (normalizedPaths.length === 0) {
    return [];
  }

  const maxResults = readPositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS);
  const knownPathSet = new Set(normalizedPaths);
  const candidates = createCandidateStore(normalizedPaths);

  applyPackageEntrypointHeuristics(candidates, knownPathSet, options);
  applyPathPatternHeuristics(candidates, normalizedPaths);
  applyShebangHeuristic(candidates, normalizedPaths, options);

  const detected = normalizedPaths
    .map((path) => candidates.get(path))
    .filter((candidate): candidate is MutableCandidate => Boolean(candidate))
    .filter((candidate) => candidate.heuristics.size > 0)
    .map((candidate) => {
      const heuristics = stableSort(
        [...candidate.heuristics.entries()].map(([heuristic, confidence]) => ({
          heuristic,
          confidence,
        })),
        (left, right) => {
          if (left.confidence !== right.confidence) {
            return right.confidence - left.confidence;
          }
          return left.heuristic.localeCompare(right.heuristic);
        },
      );
      const score = heuristics.reduce(
        (sum, entry) => sum + entry.confidence,
        0,
      );
      return {
        path: candidate.path,
        score,
        confidence: 0,
        heuristics,
      };
    });

  if (detected.length === 0) {
    return [];
  }

  const maxScore = Math.max(...detected.map((entry) => entry.score));
  const withConfidence = detected.map((entry) => ({
    ...entry,
    confidence:
      maxScore > 0 ? Math.round((entry.score / maxScore) * 100) : 0,
  }));

  return stableSort(withConfidence, (left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.heuristics.length !== right.heuristics.length) {
      return right.heuristics.length - left.heuristics.length;
    }
    return left.path.localeCompare(right.path);
  }).slice(0, maxResults);
}
