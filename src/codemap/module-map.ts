import { dirname, posix } from "node:path";
import { stableSort } from "../utils/deterministic";
import type { SymbolInfo, SymbolKind } from "../types";

const DEFAULT_MAX_MODULES = 30;
const DEFAULT_MAX_SYMBOLS_PER_MODULE = 5;
const DEFAULT_MAX_LANGUAGES_PER_MODULE = 3;

const HIGH_LEVEL_SYMBOL_KINDS = new Set<SymbolKind>([
  "class",
  "function",
  "interface",
  "type",
  "enum",
  "module",
]);

const SYMBOL_KIND_PRIORITY: Record<SymbolKind, number> = {
  class: 0,
  function: 1,
  interface: 2,
  type: 3,
  enum: 4,
  module: 5,
  variable: 6,
  method: 7,
  unknown: 8,
};

export interface ModuleMapFileInput {
  path: string;
  language: string;
  lineCount: number;
  symbols?: readonly SymbolInfo[];
}

export interface ModuleMapLanguageSummary {
  language: string;
  fileCount: number;
}

export interface ModuleMapSymbolSummary {
  kind: SymbolKind;
  signature: string;
  path: string;
  line: number;
}

export interface ModuleMapEntry {
  modulePath: string;
  fileCount: number;
  totalLines: number;
  primaryLanguages: ModuleMapLanguageSummary[];
  topSymbols: ModuleMapSymbolSummary[];
}

export interface BuildModuleMapOptions {
  maxModules?: number;
  maxSymbolsPerModule?: number;
  maxLanguagesPerModule?: number;
}

export interface BuildModuleMapResult {
  modules: ModuleMapEntry[];
  truncation: {
    maxModules: number;
    maxSymbolsPerModule: number;
    maxLanguagesPerModule: number;
    omittedModules: number;
  };
}

interface ModuleAccumulator {
  modulePath: string;
  fileCount: number;
  totalLines: number;
  languageCounts: Map<string, number>;
  symbols: ModuleMapSymbolSummary[];
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

function getModulePath(pathValue: string): string {
  const normalizedPath = pathValue.replace(/\\/g, "/");
  const directory = dirname(normalizedPath);
  if (directory === "." || directory === "") {
    return ".";
  }

  const segments = directory.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return segments[0] ?? ".";
  }

  return posix.join(segments[0]!, segments[1]!);
}

function compareLanguages(
  left: ModuleMapLanguageSummary,
  right: ModuleMapLanguageSummary,
): number {
  if (left.fileCount !== right.fileCount) {
    return right.fileCount - left.fileCount;
  }
  return left.language.localeCompare(right.language);
}

function compareSymbols(
  left: ModuleMapSymbolSummary,
  right: ModuleMapSymbolSummary,
): number {
  const leftExported = left.signature.startsWith("export ") || left.kind === "module";
  const rightExported = right.signature.startsWith("export ") || right.kind === "module";
  if (leftExported !== rightExported) {
    return Number(rightExported) - Number(leftExported);
  }

  const leftPriority = SYMBOL_KIND_PRIORITY[left.kind];
  const rightPriority = SYMBOL_KIND_PRIORITY[right.kind];
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  if (left.path !== right.path) {
    return left.path.localeCompare(right.path);
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.signature.localeCompare(right.signature);
}

function compareModules(left: ModuleAccumulator, right: ModuleAccumulator): number {
  if (left.fileCount !== right.fileCount) {
    return right.fileCount - left.fileCount;
  }
  return left.modulePath.localeCompare(right.modulePath);
}

function dedupeSymbols(
  symbols: readonly ModuleMapSymbolSummary[],
): ModuleMapSymbolSummary[] {
  const seen = new Set<string>();
  const deduped: ModuleMapSymbolSummary[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.kind}\t${symbol.path}\t${symbol.line}\t${symbol.signature}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(symbol);
  }
  return deduped;
}

export function buildModuleMap(
  files: readonly ModuleMapFileInput[],
  options: BuildModuleMapOptions = {},
): BuildModuleMapResult {
  const maxModules = normalizePositiveInt(options.maxModules, DEFAULT_MAX_MODULES);
  const maxSymbolsPerModule = normalizePositiveInt(
    options.maxSymbolsPerModule,
    DEFAULT_MAX_SYMBOLS_PER_MODULE,
  );
  const maxLanguagesPerModule = normalizePositiveInt(
    options.maxLanguagesPerModule,
    DEFAULT_MAX_LANGUAGES_PER_MODULE,
  );

  const sortedFiles = files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const modules = new Map<string, ModuleAccumulator>();

  for (const file of sortedFiles) {
    const modulePath = getModulePath(file.path);
    let module = modules.get(modulePath);
    if (!module) {
      module = {
        modulePath,
        fileCount: 0,
        totalLines: 0,
        languageCounts: new Map<string, number>(),
        symbols: [],
      };
      modules.set(modulePath, module);
    }

    module.fileCount += 1;
    module.totalLines += Math.max(0, file.lineCount);
    const currentCount = module.languageCounts.get(file.language) ?? 0;
    module.languageCounts.set(file.language, currentCount + 1);

    for (const symbol of file.symbols ?? []) {
      if (!HIGH_LEVEL_SYMBOL_KINDS.has(symbol.kind)) {
        continue;
      }
      module.symbols.push({
        kind: symbol.kind,
        signature: symbol.signature,
        path: file.path,
        line: symbol.line,
      });
    }
  }

  const orderedModules = stableSort([...modules.values()], compareModules);
  const includedModules = orderedModules.slice(0, maxModules);
  const omittedModules = Math.max(0, orderedModules.length - includedModules.length);

  const resultModules: ModuleMapEntry[] = includedModules.map((module) => {
    const primaryLanguages = stableSort(
      [...module.languageCounts.entries()].map(([language, fileCount]) => ({
        language,
        fileCount,
      })),
      compareLanguages,
    ).slice(0, maxLanguagesPerModule);

    const topSymbols = stableSort(dedupeSymbols(module.symbols), compareSymbols).slice(
      0,
      maxSymbolsPerModule,
    );

    return {
      modulePath: module.modulePath,
      fileCount: module.fileCount,
      totalLines: module.totalLines,
      primaryLanguages,
      topSymbols,
    };
  });

  return {
    modules: resultModules,
    truncation: {
      maxModules,
      maxSymbolsPerModule,
      maxLanguagesPerModule,
      omittedModules,
    },
  };
}
