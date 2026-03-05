import type {
  CtxConfig,
  SelectionEntry,
  SelectionMode,
  SelectionPriority,
  SliceRange,
  SymbolInfo,
  TokenDegradation,
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

export interface PriorityScoringSignals {
  explicitIncludePaths?: readonly string[];
  explicitIncludeGlobs?: readonly string[];
  explicitEntrypointPaths?: readonly string[];
  taskText?: string;
  reviewMode?: boolean;
  gitChangedPaths?: readonly string[];
  hitCountsByPath?: Record<string, number>;
  importHopsByPath?: Record<string, number>;
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
  neverIncludeExcludedPaths: string[];
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

export type TreeVerbosity = "full" | "selected" | "none";
export type CodemapDetail = "complete" | "summary";

export interface BudgetDegradationState {
  entries: ManagedSelectionEntry[];
  codemapDetailByPath: Record<string, CodemapDetail>;
  sliceContextLines: number;
  treeVerbosity: TreeVerbosity;
}

export interface BudgetDegradationOptions {
  budgetTokens: number;
  entries: ManagedSelectionEntry[];
  estimateTokens: (state: BudgetDegradationState) => number;
  codemapDetailByPath?: Record<string, CodemapDetail>;
  sliceContextLines?: number;
  maxSlicesPerFile?: number;
  sliceSeedsByPath?: Record<string, SliceConstructionSeed>;
  treeVerbosity?: TreeVerbosity;
  failOnOverbudget?: boolean;
}

export interface SliceConstructionSeed {
  content: string;
  taskTerms?: readonly string[];
  symbols?: readonly SymbolInfo[];
  providedSlices?: readonly SliceRange[];
}

export interface SliceConstructionOptions {
  path: string;
  content: string;
  taskTerms?: readonly string[];
  symbols?: readonly SymbolInfo[];
  providedSlices?: readonly SliceRange[];
  fallbackContextLines?: number;
  maxSlicesPerFile?: number;
}

export interface BudgetDegradationResult {
  state: BudgetDegradationState;
  budgetTokens: number;
  estimatedTokens: number;
  degradations: TokenDegradation[];
  overBudget: boolean;
  shouldFail: boolean;
  warning?: string;
}

export interface BudgetEstimateBreakdown {
  bySection: Record<string, number>;
  byFile?: Record<string, number>;
}

export interface BudgetNormalizationDegradation {
  action: string;
  targetPath?: string;
  fromMode?: string;
  toMode?: string;
  tokensSaved: number;
}

export interface BudgetNormalizationOptions {
  budgetTokens: number;
  reserveTokens?: number;
  entries: ManagedSelectionEntry[];
  estimateBreakdown: (state: BudgetDegradationState) => BudgetEstimateBreakdown;
  codemapDetailByPath?: Record<string, CodemapDetail>;
  sliceContextLines?: number;
  treeVerbosity?: TreeVerbosity;
  failOnOverbudget?: boolean;
}

export interface BudgetNormalizationReport {
  budget: number;
  effectiveBudget: number;
  initialEstimate: number;
  finalEstimate: number;
  bySection: Record<string, number>;
  byFile: Record<string, number>;
  degradations: BudgetNormalizationDegradation[];
  overBudget: boolean;
  shouldFail: boolean;
  warning?: string;
}

export interface BudgetNormalizationResult {
  state: BudgetDegradationState;
  report: BudgetNormalizationReport;
}

const DEFAULT_PRIORITY_SCORE: Record<SelectionPriority, number> = {
  core: 300,
  support: 200,
  ref: 100,
};

const DEFAULT_SLICE_CONTEXT_LINES = 30;
const MIN_SLICE_CONTEXT_LINES = 10;
const SLICE_CONTEXT_STEP = 10;
const DEFAULT_AST_AWARE_MAX_SLICES = 4;
const PRIORITY_WEIGHT_EXPLICIT_INCLUDE = 1000;
const PRIORITY_WEIGHT_TASK_MENTION = 500;
const PRIORITY_WEIGHT_GIT_CHANGED_REVIEW = 400;
const PRIORITY_WEIGHT_GIT_CHANGED_DEFAULT = 100;
const PRIORITY_WEIGHT_ENTRYPOINT_HEURISTIC = 300;
const PRIORITY_WEIGHT_HIT_DENSITY = 200;
const PRIORITY_WEIGHT_IMPORT_PROXIMITY = 150;
const PRIORITY_AGENT_BOOST: Record<SelectionPriority, number> = {
  core: 50,
  support: 25,
  ref: 0,
};

const ENTRYPOINT_HEURISTIC_PATTERN =
  /^(main|index|app|routes|server|cli)(\.[^/]+)*$/i;

function normalizeScorePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function normalizePathSet(values: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const normalizedPath = normalizeScorePath(value.trim());
    if (normalizedPath.length > 0) {
      normalized.add(normalizedPath);
    }
  }
  return normalized;
}

function normalizePathNumberMap(
  values: Record<string, number> | undefined,
  options: { allowZero: boolean },
): Map<string, number> {
  const normalized = new Map<string, number>();
  if (!values) {
    return normalized;
  }

  const orderedPaths = Object.keys(values).sort((left, right) =>
    left.localeCompare(right),
  );
  for (const path of orderedPaths) {
    const value = values[path];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (!options.allowZero && value === 0)
    ) {
      continue;
    }
    normalized.set(normalizeScorePath(path), Math.floor(value));
  }
  return normalized;
}

function matchesAnyExplicitGlob(
  path: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    if (matchGlob(path, pattern)) {
      return true;
    }
  }
  return false;
}

function hasEntrypointHeuristicPath(path: string): boolean {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return ENTRYPOINT_HEURISTIC_PATTERN.test(fileName);
}

function normalizeTaskText(taskText: string | undefined): string {
  if (!taskText) {
    return "";
  }
  return taskText.toLowerCase().replace(/\\/g, "/");
}

function computeHitDensityScore(
  path: string,
  hitCountsByPath: ReadonlyMap<string, number>,
  maxHitCount: number,
): number {
  if (maxHitCount <= 0) {
    return 0;
  }

  const hitCount = hitCountsByPath.get(path) ?? 0;
  if (hitCount <= 0) {
    return 0;
  }

  return Math.floor((hitCount / maxHitCount) * PRIORITY_WEIGHT_HIT_DENSITY);
}

function computeImportProximityScore(
  path: string,
  importHopsByPath: ReadonlyMap<string, number>,
): number {
  const hops = importHopsByPath.get(path);
  if (hops === undefined || hops < 0) {
    return 0;
  }

  return Math.floor(PRIORITY_WEIGHT_IMPORT_PROXIMITY / (hops + 1));
}

export function computeSelectionPriorityScores(
  entries: readonly SelectionEntry[],
  signals: PriorityScoringSignals = {},
): Record<string, number> {
  const explicitPathSet = normalizePathSet([
    ...(signals.explicitIncludePaths ?? []),
    ...(signals.explicitEntrypointPaths ?? []),
  ]);
  const gitChangedPathSet = normalizePathSet(signals.gitChangedPaths);
  const hitCountsByPath = normalizePathNumberMap(signals.hitCountsByPath, {
    allowZero: false,
  });
  const importHopsByPath = normalizePathNumberMap(signals.importHopsByPath, {
    allowZero: true,
  });
  const normalizedTaskText = normalizeTaskText(signals.taskText);
  const maxHitCount = Math.max(0, ...hitCountsByPath.values());
  const gitChangedWeight = signals.reviewMode
    ? PRIORITY_WEIGHT_GIT_CHANGED_REVIEW
    : PRIORITY_WEIGHT_GIT_CHANGED_DEFAULT;
  const scores: Record<string, number> = {};

  const orderedEntries = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const entry of orderedEntries) {
    const normalizedPath = normalizeScorePath(entry.path);
    let score = 0;

    if (
      explicitPathSet.has(normalizedPath) ||
      matchesAnyExplicitGlob(entry.path, signals.explicitIncludeGlobs)
    ) {
      score += PRIORITY_WEIGHT_EXPLICIT_INCLUDE;
    }

    if (
      normalizedTaskText.length > 0 &&
      normalizedTaskText.includes(normalizedPath)
    ) {
      score += PRIORITY_WEIGHT_TASK_MENTION;
    }

    if (gitChangedPathSet.has(normalizedPath)) {
      score += gitChangedWeight;
    }

    if (hasEntrypointHeuristicPath(entry.path)) {
      score += PRIORITY_WEIGHT_ENTRYPOINT_HEURISTIC;
    }

    score += computeHitDensityScore(normalizedPath, hitCountsByPath, maxHitCount);
    score += computeImportProximityScore(normalizedPath, importHopsByPath);
    score += PRIORITY_AGENT_BOOST[entry.priority];

    scores[entry.path] = Math.max(0, Math.floor(score));
  }

  return scores;
}

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

interface SymbolRange {
  signature: string;
  startLine: number;
  endLine: number;
}

interface TaskLineMatch {
  line: number;
  score: number;
  matchedTerms: string[];
}

function clampLine(value: number, totalLines: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(totalLines, Math.max(1, Math.floor(value)));
}

function lineCountForContent(content: string): number {
  return Math.max(1, content.replace(/\r\n/g, "\n").split("\n").length);
}

function normalizeTaskTerms(taskTerms: readonly string[] | undefined): string[] {
  if (!taskTerms) {
    return [];
  }
  const normalized = [...new Set(
    taskTerms
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 2),
  )];
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeSymbols(
  symbols: readonly SymbolInfo[] | undefined,
  totalLines: number,
): SymbolRange[] {
  if (!symbols || symbols.length === 0) {
    return [];
  }

  const ordered = [...symbols]
    .map((symbol) => ({
      signature: symbol.signature.trim(),
      line: clampLine(symbol.line, totalLines),
      endLine:
        symbol.endLine !== undefined
          ? clampLine(symbol.endLine, totalLines)
          : undefined,
    }))
    .sort((left, right) => {
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.signature.localeCompare(right.signature);
    });

  const ranges: SymbolRange[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const inferredEnd =
      current.endLine ??
      (next ? Math.max(current.line, next.line - 1) : totalLines);
    ranges.push({
      signature: current.signature.length > 0 ? current.signature : "(anonymous symbol)",
      startLine: current.line,
      endLine: Math.max(current.line, clampLine(inferredEnd, totalLines)),
    });
  }

  return ranges;
}

function findBestEnclosingSymbol(
  startLine: number,
  endLine: number,
  symbols: readonly SymbolRange[],
): SymbolRange | null {
  if (symbols.length === 0) {
    return null;
  }

  const containing = symbols.filter(
    (symbol) => symbol.startLine <= startLine && symbol.endLine >= endLine,
  );
  const candidates = containing.length > 0
    ? containing
    : symbols.filter(
        (symbol) =>
          symbol.startLine <= endLine && symbol.endLine >= startLine,
      );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) => {
    const leftSpan = left.endLine - left.startLine;
    const rightSpan = right.endLine - right.startLine;
    if (leftSpan !== rightSpan) {
      return leftSpan - rightSpan;
    }
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    return left.signature.localeCompare(right.signature);
  })[0]!;
}

function collectTaskLineMatches(
  content: string,
  taskTerms: readonly string[],
): TaskLineMatch[] {
  if (taskTerms.length === 0) {
    return [];
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const matches: TaskLineMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").toLowerCase();
    const matchedTerms = taskTerms.filter((term) => line.includes(term));
    if (matchedTerms.length === 0) {
      continue;
    }
    matches.push({
      line: index + 1,
      score: matchedTerms.length,
      matchedTerms: matchedTerms.sort((left, right) => left.localeCompare(right)),
    });
  }

  return matches.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.line - right.line;
  });
}

function mergeTextParts(left: string, right: string): string {
  const values = new Set<string>();
  for (const value of `${left}; ${right}`.split(";")) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      values.add(trimmed);
    }
  }
  return [...values].join("; ");
}

function mergeOverlappingSlices(slices: readonly SliceRange[]): SliceRange[] {
  const ordered = normalizedSlices(slices);
  if (ordered.length <= 1) {
    return ordered;
  }

  const merged: SliceRange[] = [{ ...ordered[0] }];
  for (let index = 1; index < ordered.length; index += 1) {
    const next = ordered[index];
    const current = merged[merged.length - 1];
    if (next.startLine <= current.endLine + 1) {
      merged[merged.length - 1] = {
        startLine: Math.min(current.startLine, next.startLine),
        endLine: Math.max(current.endLine, next.endLine),
        description: mergeTextParts(current.description, next.description),
        rationale: mergeTextParts(current.rationale, next.rationale),
      };
      continue;
    }
    merged.push({ ...next });
  }

  return merged;
}

function buildFallbackSlice(
  line: number,
  totalLines: number,
  contextLines: number,
  description: string,
  rationale: string,
): SliceRange {
  const startLine = clampLine(line - contextLines, totalLines);
  const endLine = clampLine(line + contextLines, totalLines);
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    description,
    rationale,
  };
}

export function constructAstAwareSlices(
  options: SliceConstructionOptions,
): SliceRange[] {
  const totalLines = lineCountForContent(options.content);
  const contextLines = normalizeSliceContextLines(options.fallbackContextLines);
  const maxSlicesPerFile = Math.max(
    1,
    Math.floor(options.maxSlicesPerFile ?? DEFAULT_AST_AWARE_MAX_SLICES),
  );
  const symbols = normalizeSymbols(options.symbols, totalLines);
  const taskTerms = normalizeTaskTerms(options.taskTerms);
  const candidateSlices: SliceRange[] = [];

  if (options.providedSlices && options.providedSlices.length > 0) {
    for (const providedSlice of normalizedSlices(options.providedSlices)) {
      const startLine = clampLine(providedSlice.startLine, totalLines);
      const endLine = clampLine(providedSlice.endLine, totalLines);
      const symbol = findBestEnclosingSymbol(startLine, endLine, symbols);
      const expanded = symbol
        ? {
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            description: `enclosing symbol: ${symbol.signature}`,
            rationale: mergeTextParts(
              providedSlice.rationale,
              "expanded to enclosing symbol boundary",
            ),
          }
        : {
            startLine: Math.min(startLine, endLine),
            endLine: Math.max(startLine, endLine),
            description: providedSlice.description,
            rationale: providedSlice.rationale,
          };
      candidateSlices.push(expanded);
    }
  } else {
    const lineMatches = collectTaskLineMatches(options.content, taskTerms);
    if (lineMatches.length > 0) {
      for (const match of lineMatches) {
        const symbol = findBestEnclosingSymbol(match.line, match.line, symbols);
        if (symbol) {
          candidateSlices.push({
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            description: `task-relevant symbol: ${symbol.signature}`,
            rationale: `task-term match (${match.matchedTerms.join(", ")}) near line ${match.line}`,
          });
          continue;
        }
        candidateSlices.push(
          buildFallbackSlice(
            match.line,
            totalLines,
            contextLines,
            `task-relevant context around line ${match.line}`,
            `fallback window for task-term match (${match.matchedTerms.join(", ")})`,
          ),
        );
      }
    }
  }

  if (candidateSlices.length === 0) {
    if (symbols.length > 0) {
      const firstSymbol = symbols[0]!;
      candidateSlices.push({
        startLine: firstSymbol.startLine,
        endLine: firstSymbol.endLine,
        description: `primary symbol: ${firstSymbol.signature}`,
        rationale: "no explicit term matches; selected deterministic primary symbol",
      });
    } else {
      candidateSlices.push(
        buildFallbackSlice(
          1,
          totalLines,
          contextLines,
          `file head context for ${options.path}`,
          "no symbols or task-term matches available",
        ),
      );
    }
  }

  const merged = mergeOverlappingSlices(candidateSlices);
  const capped =
    merged.length > maxSlicesPerFile
      ? mergeClosestSlices(merged, maxSlicesPerFile)
      : merged;

  return capped.map((slice) => ({
    startLine: Math.min(slice.startLine, slice.endLine),
    endLine: Math.max(slice.startLine, slice.endLine),
    description: slice.description.trim(),
    rationale: slice.rationale.trim(),
  }));
}

function cloneManagedEntries(
  entries: readonly ManagedSelectionEntry[],
): ManagedSelectionEntry[] {
  return entries.map((entry) => cloneManagedEntry(entry));
}

function sortCodemapDetailMap(
  detailByPath: Record<string, CodemapDetail>,
): Record<string, CodemapDetail> {
  const sorted: Record<string, CodemapDetail> = {};
  const keys = Object.keys(detailByPath).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = detailByPath[key];
    sorted[key] = value === "summary" ? "summary" : "complete";
  }
  return sorted;
}

function buildInitialCodemapDetails(
  entries: readonly ManagedSelectionEntry[],
  detailByPath: Record<string, CodemapDetail> | undefined,
): Record<string, CodemapDetail> {
  const seeded = sortCodemapDetailMap(detailByPath ?? {});
  const sortedPaths = [...entries].map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
  for (const path of sortedPaths) {
    if (!(path in seeded)) {
      seeded[path] = "complete";
    }
  }
  return seeded;
}

function normalizeSliceContextLines(sliceContextLines: number | undefined): number {
  if (
    typeof sliceContextLines === "number" &&
    Number.isFinite(sliceContextLines) &&
    sliceContextLines > 0
  ) {
    return Math.floor(sliceContextLines);
  }
  return DEFAULT_SLICE_CONTEXT_LINES;
}

function createBudgetState(input: {
  entries: readonly ManagedSelectionEntry[];
  codemapDetailByPath?: Record<string, CodemapDetail>;
  sliceContextLines?: number;
  treeVerbosity?: TreeVerbosity;
}): BudgetDegradationState {
  return {
    entries: cloneManagedEntries(input.entries).sort(compareEntriesByPriority),
    codemapDetailByPath: buildInitialCodemapDetails(
      input.entries,
      input.codemapDetailByPath,
    ),
    sliceContextLines: normalizeSliceContextLines(input.sliceContextLines),
    treeVerbosity: input.treeVerbosity ?? "full",
  };
}

function normalizeTokenMap(values: Record<string, number> | undefined): Record<string, number> {
  const normalized: Record<string, number> = {};
  const keys = Object.keys(values ?? {}).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = values?.[key];
    if (!Number.isFinite(value) || (value ?? 0) < 0) {
      throw new Error(`Token estimate for key '${key}' must be a finite number >= 0`);
    }
    normalized[key] = Math.floor(value as number);
  }
  return normalized;
}

function sumTokenMap(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function normalizeEstimateBreakdown(
  value: BudgetEstimateBreakdown,
): { bySection: Record<string, number>; byFile: Record<string, number>; total: number } {
  const bySection = normalizeTokenMap(value.bySection);
  const byFile = normalizeTokenMap(value.byFile);
  return {
    bySection,
    byFile,
    total: sumTokenMap(bySection),
  };
}

function parseBudgetNormalizationDegradation(
  degradation: TokenDegradation,
): BudgetNormalizationDegradation {
  if (degradation.step === "full_to_slices" || degradation.step === "slices_to_codemap_only") {
    const match = /^degrade (.+) ([a-z_]+)->([a-z_]+)$/.exec(degradation.reason);
    if (match) {
      return {
        action: degradation.step,
        targetPath: match[1],
        fromMode: match[2],
        toMode: match[3],
        tokensSaved: degradation.delta,
      };
    }
  }

  if (degradation.step === "drop_codemap_only") {
    const match = /^drop (.+) codemap_only$/.exec(degradation.reason);
    if (match) {
      return {
        action: degradation.step,
        targetPath: match[1],
        fromMode: "codemap_only",
        tokensSaved: degradation.delta,
      };
    }
  }

  if (degradation.step === "codemap_complete_to_summary") {
    const match = /^shrink codemap detail for (.+) complete->summary$/.exec(
      degradation.reason,
    );
    if (match) {
      return {
        action: degradation.step,
        targetPath: match[1],
        fromMode: "complete",
        toMode: "summary",
        tokensSaved: degradation.delta,
      };
    }
  }

  if (degradation.step === "shrink_slice_windows") {
    const match = /^shrink slice context \+\/-(\d+)->\+\/-(\d+)$/.exec(degradation.reason);
    if (match) {
      return {
        action: degradation.step,
        fromMode: `+/-${match[1]}`,
        toMode: `+/-${match[2]}`,
        tokensSaved: degradation.delta,
      };
    }
  }

  if (degradation.step === "reduce_tree_verbosity") {
    const match = /^reduce tree verbosity ([a-z_]+)->([a-z_]+)$/.exec(
      degradation.reason,
    );
    if (match) {
      return {
        action: degradation.step,
        fromMode: match[1],
        toMode: match[2],
        tokensSaved: degradation.delta,
      };
    }
  }

  return {
    action: degradation.step,
    tokensSaved: degradation.delta,
  };
}

function nextSliceContextLines(current: number): number | null {
  if (current > DEFAULT_SLICE_CONTEXT_LINES) {
    return DEFAULT_SLICE_CONTEXT_LINES;
  }
  if (current > 20) {
    return 20;
  }
  if (current > MIN_SLICE_CONTEXT_LINES) {
    return MIN_SLICE_CONTEXT_LINES;
  }
  return null;
}

function mergeSlicesForBudgetStep(
  slices: readonly SliceRange[],
  targetContextLines: number,
): SliceRange[] {
  const gapThreshold =
    targetContextLines <= MIN_SLICE_CONTEXT_LINES
      ? 1
      : Math.max(2, Math.floor(targetContextLines / SLICE_CONTEXT_STEP));

  const ordered = normalizedSlices(slices);
  if (ordered.length <= 1) {
    return ordered;
  }

  const merged: SliceRange[] = [{ ...ordered[0] }];
  for (let index = 1; index < ordered.length; index += 1) {
    const current = merged[merged.length - 1];
    const next = ordered[index];
    const gap = next.startLine - current.endLine;

    if (gap <= gapThreshold) {
      merged[merged.length - 1] = mergeTwoSlices(current, next);
      continue;
    }

    merged.push({ ...next });
  }

  return merged;
}

function estimateBudgetState(
  state: BudgetDegradationState,
  estimateTokens: (state: BudgetDegradationState) => number,
): number {
  const estimated = estimateTokens({
    entries: cloneManagedEntries(state.entries),
    codemapDetailByPath: sortCodemapDetailMap(state.codemapDetailByPath),
    sliceContextLines: state.sliceContextLines,
    treeVerbosity: state.treeVerbosity,
  });
  if (!Number.isFinite(estimated) || estimated < 0) {
    throw new Error("Budget estimator must return a finite, non-negative token count");
  }
  return Math.floor(estimated);
}

export function applyDeterministicBudgetDegradation(
  options: BudgetDegradationOptions,
): BudgetDegradationResult {
  if (!Number.isFinite(options.budgetTokens) || options.budgetTokens < 0) {
    throw new Error("budgetTokens must be a finite number >= 0");
  }

  const budgetTokens = Math.floor(options.budgetTokens);
  const state = createBudgetState({
    entries: options.entries,
    codemapDetailByPath: options.codemapDetailByPath,
    sliceContextLines: options.sliceContextLines,
    treeVerbosity: options.treeVerbosity,
  });

  const degradations: TokenDegradation[] = [];
  let estimatedTokens = estimateBudgetState(state, options.estimateTokens);

  const finalize = (warning?: string): BudgetDegradationResult => {
    const overBudget = estimatedTokens > budgetTokens;
    return {
      state: {
        entries: cloneManagedEntries(state.entries).sort(compareEntriesByPriority),
        codemapDetailByPath: sortCodemapDetailMap(state.codemapDetailByPath),
        sliceContextLines: state.sliceContextLines,
        treeVerbosity: state.treeVerbosity,
      },
      budgetTokens,
      estimatedTokens,
      degradations: degradations.map((item) => ({ ...item })),
      overBudget,
      shouldFail: overBudget && (options.failOnOverbudget ?? false),
      warning,
    };
  };

  const applyMutation = (
    step: string,
    reason: string,
    mutate: () => void,
  ): boolean => {
    const previousTokens = estimatedTokens;
    mutate();
    estimatedTokens = estimateBudgetState(state, options.estimateTokens);
    degradations.push({
      step,
      reason,
      delta: previousTokens - estimatedTokens,
    });
    return estimatedTokens <= budgetTokens;
  };

  if (estimatedTokens <= budgetTokens) {
    return finalize();
  }

  const maxSlicesPerFile = Math.max(
    1,
    Math.floor(options.maxSlicesPerFile ?? DEFAULT_AST_AWARE_MAX_SLICES),
  );

  const fullCandidates = state.entries
    .filter((entry) => entry.mode === "full")
    .sort(compareEntriesForConstraintDrop);
  for (const candidate of fullCandidates) {
    const isWithinBudget = applyMutation(
      "full_to_slices",
      `degrade ${candidate.path} full->slices`,
      () => {
        const sliceSeed = options.sliceSeedsByPath?.[candidate.path];
        const autoSlices = sliceSeed
          ? constructAstAwareSlices({
              path: candidate.path,
              content: sliceSeed.content,
              taskTerms: sliceSeed.taskTerms,
              symbols: sliceSeed.symbols,
              providedSlices: sliceSeed.providedSlices,
              fallbackContextLines: state.sliceContextLines,
              maxSlicesPerFile,
            })
          : [
              {
                startLine: 1,
                endLine: 1,
                description: "budget degradation full->slices",
                rationale: "deterministic budget ladder",
              },
            ];
        state.entries = state.entries.map((entry) => {
          if (entry.path !== candidate.path || entry.mode !== "full") {
            return entry;
          }
          return {
            ...entry,
            mode: "slices",
            slices: autoSlices,
          };
        });
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  const sliceCandidates = state.entries
    .filter((entry) => entry.mode === "slices")
    .sort(compareEntriesForConstraintDrop);
  for (const candidate of sliceCandidates) {
    const isWithinBudget = applyMutation(
      "slices_to_codemap_only",
      `degrade ${candidate.path} slices->codemap_only`,
      () => {
        state.entries = state.entries.map((entry) => {
          if (entry.path !== candidate.path || entry.mode !== "slices") {
            return entry;
          }
          return {
            path: entry.path,
            mode: "codemap_only",
            priority: entry.priority,
            rationale: entry.rationale,
            priorityScore: entry.priorityScore,
            isBinary: entry.isBinary,
            fileBytes: entry.fileBytes,
          };
        });
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  const codemapCandidates = state.entries
    .filter((entry) => entry.mode === "codemap_only")
    .sort(compareEntriesForConstraintDrop);
  for (const candidate of codemapCandidates) {
    const isWithinBudget = applyMutation(
      "drop_codemap_only",
      `drop ${candidate.path} codemap_only`,
      () => {
        state.entries = state.entries.filter((entry) => entry.path !== candidate.path);
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  const codemapDetailCandidates = Object.keys(state.codemapDetailByPath).sort((a, b) =>
    a.localeCompare(b),
  );
  for (const path of codemapDetailCandidates) {
    if (state.codemapDetailByPath[path] !== "complete") {
      continue;
    }
    const isWithinBudget = applyMutation(
      "codemap_complete_to_summary",
      `shrink codemap detail for ${path} complete->summary`,
      () => {
        state.codemapDetailByPath[path] = "summary";
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  while (true) {
    const targetContext = nextSliceContextLines(state.sliceContextLines);
    if (targetContext === null) {
      break;
    }

    const previousContext = state.sliceContextLines;
    const isWithinBudget = applyMutation(
      "shrink_slice_windows",
      `shrink slice context +/-${previousContext}->+/-${targetContext}`,
      () => {
        state.entries = state.entries.map((entry) => {
          if (entry.mode !== "slices") {
            return entry;
          }
          return {
            ...entry,
            slices: mergeSlicesForBudgetStep(entry.slices, targetContext),
          };
        });
        state.sliceContextLines = targetContext;
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  while (state.treeVerbosity !== "none") {
    const nextVerbosity: TreeVerbosity =
      state.treeVerbosity === "full" ? "selected" : "none";
    const fromVerbosity = state.treeVerbosity;
    const isWithinBudget = applyMutation(
      "reduce_tree_verbosity",
      `reduce tree verbosity ${fromVerbosity}->${nextVerbosity}`,
      () => {
        state.treeVerbosity = nextVerbosity;
      },
    );
    if (isWithinBudget) {
      return finalize();
    }
  }

  if (estimatedTokens > budgetTokens) {
    return finalize(
      `Estimated prompt tokens ${estimatedTokens} exceed budget ${budgetTokens} after deterministic degradation`,
    );
  }

  return finalize();
}

export function runBudgetNormalizationLoop(
  options: BudgetNormalizationOptions,
): BudgetNormalizationResult {
  if (!Number.isFinite(options.budgetTokens) || options.budgetTokens < 0) {
    throw new Error("budgetTokens must be a finite number >= 0");
  }
  if (
    options.reserveTokens !== undefined &&
    (!Number.isFinite(options.reserveTokens) || options.reserveTokens < 0)
  ) {
    throw new Error("reserveTokens must be a finite number >= 0");
  }

  const budget = Math.floor(options.budgetTokens);
  const reserveTokens = Math.floor(options.reserveTokens ?? 0);
  const effectiveBudget = Math.max(0, budget - reserveTokens);

  const initialState = createBudgetState({
    entries: options.entries,
    codemapDetailByPath: options.codemapDetailByPath,
    sliceContextLines: options.sliceContextLines,
    treeVerbosity: options.treeVerbosity,
  });
  const initialEstimate = normalizeEstimateBreakdown(
    options.estimateBreakdown(initialState),
  );

  const degradationResult = applyDeterministicBudgetDegradation({
    budgetTokens: effectiveBudget,
    entries: options.entries,
    codemapDetailByPath: options.codemapDetailByPath,
    sliceContextLines: options.sliceContextLines,
    treeVerbosity: options.treeVerbosity,
    failOnOverbudget: options.failOnOverbudget,
    estimateTokens: (state) =>
      normalizeEstimateBreakdown(options.estimateBreakdown(state)).total,
  });

  const finalEstimate = normalizeEstimateBreakdown(
    options.estimateBreakdown(degradationResult.state),
  );

  const overBudget = finalEstimate.total > effectiveBudget;
  const warning =
    degradationResult.warning ??
    (overBudget
      ? `Estimated prompt tokens ${finalEstimate.total} exceed effective budget ${effectiveBudget}`
      : undefined);

  return {
    state: degradationResult.state,
    report: {
      budget,
      effectiveBudget,
      initialEstimate: initialEstimate.total,
      finalEstimate: finalEstimate.total,
      bySection: finalEstimate.bySection,
      byFile: finalEstimate.byFile,
      degradations: degradationResult.degradations.map((degradation) =>
        parseBudgetNormalizationDegradation(degradation),
      ),
      overBudget,
      shouldFail: overBudget && (options.failOnOverbudget ?? false),
      warning,
    },
  };
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
  private readonly neverIncludeExcludedPaths = new Set<string>();
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
      this.neverIncludeExcludedPaths.add(validatedEntry.path);
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

  finalizePriorityScores(
    signals: PriorityScoringSignals = {},
  ): ManagedSelectionEntry[] {
    const orderedEntries = [...this.entries.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const scoresByPath = computeSelectionPriorityScores(orderedEntries, signals);

    for (const entry of orderedEntries) {
      const score = scoresByPath[entry.path];
      this.entries.set(entry.path, {
        ...entry,
        priorityScore:
          typeof score === "number" && Number.isFinite(score)
            ? Math.max(0, Math.floor(score))
            : 0,
      });
    }

    return this.getAll();
  }

  enforceHardConstraints(): ConstraintEnforcementResult {
    const actions: ConstraintAction[] = [];

    for (const [path, entry] of this.entries) {
      if (shouldNeverInclude(path, this.options.neverInclude)) {
        this.entries.delete(path);
        this.neverIncludeExcludedPaths.add(path);
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
    this.neverIncludeExcludedPaths.clear();
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
      neverIncludeExcludedPaths: [...this.neverIncludeExcludedPaths].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }
}
