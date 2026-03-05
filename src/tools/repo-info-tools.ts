import { basename, extname, resolve } from "node:path";
import {
  buildModuleMap,
  type BuildModuleMapOptions,
  type ModuleMapFileInput,
} from "../codemap";
import type { SymbolInfo } from "../types";

const INDEX_STATUSES = ["fresh", "stale", "none"] as const;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".kt": "kotlin",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const BUILD_HINT_RULES: Array<{ hint: string; files: readonly string[] }> = [
  { hint: "package.json (npm/bun)", files: ["package.json"] },
  { hint: "bun.lock (bun)", files: ["bun.lock"] },
  { hint: "tsconfig.json (typescript)", files: ["tsconfig.json"] },
  { hint: "Cargo.toml (rust)", files: ["cargo.toml"] },
  { hint: "go.mod (go)", files: ["go.mod"] },
  { hint: "requirements.txt (python)", files: ["requirements.txt"] },
  { hint: "pyproject.toml (python)", files: ["pyproject.toml"] },
  { hint: "Pipfile (python)", files: ["pipfile"] },
  { hint: "poetry.lock (python)", files: ["poetry.lock"] },
  { hint: "Gemfile (ruby)", files: ["gemfile"] },
  { hint: "pom.xml (maven)", files: ["pom.xml"] },
  { hint: "build.gradle (gradle)", files: ["build.gradle", "build.gradle.kts"] },
  { hint: "Makefile (make)", files: ["makefile"] },
  { hint: "CMakeLists.txt (cmake)", files: ["cmakelists.txt"] },
  { hint: "Dockerfile (docker)", files: ["dockerfile"] },
];

export type RepoInfoIndexStatus = (typeof INDEX_STATUSES)[number];

export interface RepoInfoFileDescriptor {
  path: string;
  language?: string;
  lineCount?: number;
  symbols?: readonly SymbolInfo[];
}

export interface RepoInfoIgnoreSummaryInput {
  gitignorePatterns?: number;
  configIgnores?: number;
}

export interface RepoInfoToolsContext {
  repoRoot: string;
  repoFiles: readonly string[];
  scannedFiles?: readonly RepoInfoFileDescriptor[];
  indexStatus?: string;
  ignoreSummary?: RepoInfoIgnoreSummaryInput;
  gitignorePatternCount?: number;
  configIgnorePatterns?: readonly string[];
  moduleMapFiles?: readonly ModuleMapFileInput[];
  moduleMapOptions?: BuildModuleMapOptions;
}

export interface RepoInfoValidationResultOk {
  ok: true;
}

export interface RepoInfoValidationResultErr {
  ok: false;
  message: string;
}

export type RepoInfoValidationResult =
  | RepoInfoValidationResultOk
  | RepoInfoValidationResultErr;

export interface RepoInfoIgnoreSummary {
  gitignore_patterns: number;
  config_ignores: number;
}

export interface RepoInfoLanguageStats {
  [language: string]: number;
}

export interface RepoInfoModuleLanguageSummary {
  language: string;
  file_count: number;
}

export interface RepoInfoModuleSymbolSummary {
  kind: string;
  signature: string;
  path: string;
  line: number;
}

export interface RepoInfoModuleEntry {
  module_path: string;
  file_count: number;
  total_lines: number;
  primary_languages: RepoInfoModuleLanguageSummary[];
  top_symbols: RepoInfoModuleSymbolSummary[];
}

export interface RepoInfoModuleMap {
  modules: RepoInfoModuleEntry[];
  truncation: {
    max_modules: number;
    max_symbols_per_module: number;
    max_languages_per_module: number;
    omitted_modules: number;
  };
}

export interface RepoInfoResult {
  repo_root: string;
  total_files: number;
  language_stats: RepoInfoLanguageStats;
  index_status: RepoInfoIndexStatus;
  ignore_summary: RepoInfoIgnoreSummary;
  build_hints: string[];
  module_map: RepoInfoModuleMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeLanguage(value: string | undefined, pathValue: string): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized && normalized.length > 0) {
    return normalized;
  }
  const extension = extname(pathValue).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

function normalizeIndexStatus(value: string | undefined): RepoInfoIndexStatus {
  if (typeof value !== "string") {
    return "none";
  }
  const normalized = value.trim().toLowerCase();
  if (INDEX_STATUSES.includes(normalized as RepoInfoIndexStatus)) {
    return normalized as RepoInfoIndexStatus;
  }
  return "none";
}

function collectLanguageStats(context: RepoInfoToolsContext): RepoInfoLanguageStats {
  const counts = new Map<string, number>();
  const inputs =
    context.scannedFiles && context.scannedFiles.length > 0
      ? context.scannedFiles
      : context.repoFiles.map((pathValue) => ({ path: pathValue }));

  for (const file of inputs) {
    const language = normalizeLanguage(file.language, file.path);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  const orderedEntries = [...counts.entries()].sort((left, right) =>
    right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
  );

  const languageStats: RepoInfoLanguageStats = {};
  for (const [language, count] of orderedEntries) {
    languageStats[language] = count;
  }
  return languageStats;
}

function collectBuildHints(repoFiles: readonly string[]): string[] {
  const normalizedFiles = repoFiles.map((pathValue) => pathValue.toLowerCase());
  const hasFile = (needle: string): boolean =>
    normalizedFiles.some((pathValue) => pathValue === needle || pathValue.endsWith(`/${needle}`));

  const hints: string[] = [];
  for (const rule of BUILD_HINT_RULES) {
    if (rule.files.some((fileName) => hasFile(fileName))) {
      hints.push(rule.hint);
    }
  }
  return hints;
}

function resolveIgnoreSummary(context: RepoInfoToolsContext): RepoInfoIgnoreSummary {
  return {
    gitignore_patterns: normalizeNonNegativeInteger(
      context.ignoreSummary?.gitignorePatterns ?? context.gitignorePatternCount,
      0,
    ),
    config_ignores: normalizeNonNegativeInteger(
      context.ignoreSummary?.configIgnores ?? context.configIgnorePatterns?.length,
      0,
    ),
  };
}

function resolveModuleMapInput(context: RepoInfoToolsContext): ModuleMapFileInput[] {
  if (context.moduleMapFiles && context.moduleMapFiles.length > 0) {
    return [...context.moduleMapFiles].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  if (!context.scannedFiles || context.scannedFiles.length === 0) {
    return [];
  }

  return [...context.scannedFiles]
    .map((file) => ({
      path: file.path,
      language: normalizeLanguage(file.language, file.path),
      lineCount: normalizeNonNegativeInteger(file.lineCount, 0),
      symbols: file.symbols ? [...file.symbols] : [],
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function toRepoInfoModuleMap(context: RepoInfoToolsContext): RepoInfoModuleMap {
  const moduleMap = buildModuleMap(resolveModuleMapInput(context), context.moduleMapOptions);
  return {
    modules: moduleMap.modules.map((module) => ({
      module_path: module.modulePath,
      file_count: module.fileCount,
      total_lines: module.totalLines,
      primary_languages: module.primaryLanguages.map((language) => ({
        language: language.language,
        file_count: language.fileCount,
      })),
      top_symbols: module.topSymbols.map((symbol) => ({
        kind: symbol.kind,
        signature: symbol.signature,
        path: symbol.path,
        line: symbol.line,
      })),
    })),
    truncation: {
      max_modules: moduleMap.truncation.maxModules,
      max_symbols_per_module: moduleMap.truncation.maxSymbolsPerModule,
      max_languages_per_module: moduleMap.truncation.maxLanguagesPerModule,
      omitted_modules: moduleMap.truncation.omittedModules,
    },
  };
}

export function validateRepoInfoArgs(args: unknown): RepoInfoValidationResult {
  if (args === undefined) {
    return { ok: true };
  }
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object when provided" };
  }
  if (Object.keys(args).length > 0) {
    return { ok: false, message: "repo_info does not accept arguments" };
  }
  return { ok: true };
}

export function executeRepoInfo(
  _args: Record<string, never> | undefined,
  context: RepoInfoToolsContext,
): RepoInfoResult {
  const resolvedRepoRoot = resolve(context.repoRoot);
  const repoRootName = basename(resolvedRepoRoot) || resolvedRepoRoot;
  const totalFiles =
    context.scannedFiles && context.scannedFiles.length > 0
      ? context.scannedFiles.length
      : context.repoFiles.length;

  return {
    repo_root: repoRootName,
    total_files: totalFiles,
    language_stats: collectLanguageStats(context),
    index_status: normalizeIndexStatus(context.indexStatus),
    ignore_summary: resolveIgnoreSummary(context),
    build_hints: collectBuildHints(context.repoFiles),
    module_map: toRepoInfoModuleMap(context),
  };
}
