import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  persistRunArtifacts,
  type PersistRunArtifactsResult,
  type StoredRunRecord,
} from "../artifacts";
import { compileExtraRedactPatterns, redactText } from "../privacy";
import { runOfflineDiscovery } from "../discovery";
import {
  applyIncrementalIndexUpdate,
  openSqliteIndex,
  resolveIndexDatabasePath,
  type ApplyIncrementalIndexResult,
} from "../index-manager";
import {
  formatPromptOutput,
  renderPromptSections,
  type FilesSectionEntry,
  type FilesSectionSlice,
  type MetadataField,
} from "../prompt";
import { renderTemplate, type TemplateValues } from "../prompt/template-engine";
import { getTemplateByName } from "../prompt/templates";
import { walkRepositoryFiles, type WalkRepositoryResult } from "../scanner";
import {
  runBudgetNormalizationLoop,
  selectionManagerOptionsFromConfig,
  SelectionManager,
  type BudgetDegradationState,
  type BudgetEstimateBreakdown,
  type ManagedSelectionEntry,
  type TreeVerbosity,
} from "../selection";
import type { CodemapEntry, CtxConfig, SelectionEntry, TokenReport } from "../types";
import { stableHash } from "../utils/deterministic";
import { estimateTokensFromText } from "../utils/token-estimate";

const CODEMAP_COMPLETE_TOKENS = 160;
const CODEMAP_SUMMARY_TOKENS = 80;
const ESTIMATED_METADATA_TOKENS = 180;
const DEFAULT_SLICE_CONTEXT_LINES = 30;
const MAX_TREE_LINES = 256;

export interface MainPipelineRunnerOptions {
  repoRoot: string;
  task: string;
  config: CtxConfig;
  runId: string;
  failOnOverbudget?: boolean;
  now?: () => Date;
  readFileText?: (absolutePath: string) => string;
}

export interface MainPipelineRunnerResult {
  runId: string;
  prompt: string;
  promptTokens: number;
  filesScanned: number;
  filesSelected: number;
  discoveryBackend: "offline";
  scan: WalkRepositoryResult;
  index: ApplyIncrementalIndexResult;
  tokenReport: TokenReport;
  selection: ManagedSelectionEntry[];
  runRecord: StoredRunRecord;
  artifacts: PersistRunArtifactsResult;
}

function normalizeRepoPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function toTreeVerbosity(mode: CtxConfig["defaults"]["treeMode"]): TreeVerbosity {
  if (mode === "full" || mode === "selected" || mode === "none") {
    return mode;
  }
  return "selected";
}

function toSelectionEntries(
  entries: readonly ManagedSelectionEntry[],
): SelectionEntry[] {
  return entries.map((entry) => {
    if (entry.mode === "slices") {
      return {
        path: entry.path,
        mode: entry.mode,
        priority: entry.priority,
        rationale: entry.rationale,
        slices: entry.slices.map((slice) => ({ ...slice })),
      };
    }
    return {
      path: entry.path,
      mode: entry.mode,
      priority: entry.priority,
      rationale: entry.rationale,
    };
  });
}

function createRepoFileReader(options: {
  repoRoot: string;
  readFileText?: (absolutePath: string) => string;
}): (relativePath: string) => string {
  const cache = new Map<string, string>();
  const readFileText =
    options.readFileText ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const repoRoot = resolve(options.repoRoot);

  return (relativePath: string): string => {
    const normalizedPath = normalizeRepoPath(relativePath);
    const cached = cache.get(normalizedPath);
    if (cached !== undefined) {
      return cached;
    }
    const absolutePath = resolve(repoRoot, normalizedPath);
    let text = "";
    try {
      text = readFileText(absolutePath);
    } catch {
      text = "";
    }
    cache.set(normalizedPath, text);
    return text;
  };
}

function readSliceText(content: string, startLine: number, endLine: number): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.max(startIndex, endLine);
  return lines.slice(startIndex, endIndex).join("\n");
}

function estimateSelectionBreakdown(
  state: BudgetDegradationState,
  readFileText: (pathValue: string) => string,
): BudgetEstimateBreakdown {
  const orderedEntries = state.entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const byFile: Record<string, number> = {};
  let filesTokens = 0;

  for (const entry of orderedEntries) {
    const content = readFileText(entry.path);
    let entryTokens = 0;

    if (entry.mode === "full") {
      entryTokens = estimateTokensFromText(content);
    } else if (entry.mode === "slices") {
      entryTokens += estimateTokensFromText(entry.rationale);
      for (const slice of entry.slices) {
        const sliceText = readSliceText(content, slice.startLine, slice.endLine);
        entryTokens += estimateTokensFromText(sliceText);
      }
    } else {
      const detail = state.codemapDetailByPath[entry.path] ?? "summary";
      entryTokens = detail === "complete" ? CODEMAP_COMPLETE_TOKENS : CODEMAP_SUMMARY_TOKENS;
    }

    byFile[entry.path] = entryTokens;
    filesTokens += entryTokens;
  }

  return {
    bySection: {
      files: filesTokens,
      metadata: ESTIMATED_METADATA_TOKENS,
    },
    byFile,
  };
}

function buildFilesSectionEntries(
  entries: readonly ManagedSelectionEntry[],
  readFileText: (pathValue: string) => string,
): FilesSectionEntry[] {
  const orderedEntries = entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));

  return orderedEntries.map((entry) => {
    if (entry.mode === "full") {
      return {
        path: entry.path,
        mode: entry.mode,
        priority: entry.priority,
        rationale: entry.rationale,
        content: readFileText(entry.path),
      };
    }

    if (entry.mode === "slices") {
      const content = readFileText(entry.path);
      const slices: FilesSectionSlice[] = entry.slices.map((slice) => ({
        ...slice,
        content: readSliceText(content, slice.startLine, slice.endLine),
      }));
      return {
        path: entry.path,
        mode: entry.mode,
        priority: entry.priority,
        rationale: entry.rationale,
        slices,
      };
    }

    return {
      path: entry.path,
      mode: entry.mode,
      priority: entry.priority,
      rationale: entry.rationale,
    };
  });
}

function buildLanguageStats(
  files: readonly { language: string }[],
): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const file of files) {
    const key = file.language || "unknown";
    stats[key] = (stats[key] ?? 0) + 1;
  }
  return stats;
}

function buildTokenReport(
  budget: number,
  report: ReturnType<typeof runBudgetNormalizationLoop>["report"],
): TokenReport {
  return {
    budget,
    estimated: report.finalEstimate,
    bySection: report.bySection,
    byFile: report.byFile,
    degradations: report.degradations.map((degradation) => ({
      step: degradation.action,
      reason: degradation.targetPath ? `target=${degradation.targetPath}` : "global",
      delta: degradation.tokensSaved,
    })),
  };
}

function buildCodemapEntries(
  entries: readonly ManagedSelectionEntry[],
  filesByPath: ReadonlyMap<string, { language: string }>,
  readFileText: (pathValue: string) => string,
): CodemapEntry[] {
  const codemapPaths = entries
    .filter((entry) => entry.mode === "codemap_only")
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));

  return codemapPaths.map((path) => ({
    path,
    language: filesByPath.get(path)?.language ?? "text",
    lines: readFileText(path).replace(/\r\n/g, "\n").split("\n").length,
    symbols: [],
  }));
}

function buildTreeSection(
  paths: readonly string[],
  selectedPathSet: ReadonlySet<string>,
  verbosity: TreeVerbosity,
): string {
  if (verbosity === "none") {
    return "- none";
  }

  const sortedPaths = paths.slice().sort((left, right) => left.localeCompare(right));
  const treePaths =
    verbosity === "full"
      ? sortedPaths
      : sortedPaths.filter((pathValue) => selectedPathSet.has(pathValue));

  if (treePaths.length === 0) {
    return "- none";
  }

  const lines = treePaths.slice(0, MAX_TREE_LINES).map((path) => `- ${path}`);
  if (treePaths.length > MAX_TREE_LINES) {
    lines.push(`- ... (${treePaths.length - MAX_TREE_LINES} more paths)`);
  }
  return lines.join("\n");
}

function sectionsToTemplateValues(input: {
  repoRoot: string;
  runId: string;
  budgetTokens: number;
  estimatedPromptTokens: number;
  lineNumbers: boolean;
  privacyMode: CtxConfig["privacy"]["mode"];
  discoveryBackend: string;
  diffMode: string;
  task: string;
  sectionBodies: Record<string, string>;
}): TemplateValues {
  return {
    REPO_ROOT: input.repoRoot,
    RUN_ID: input.runId,
    BUDGET_TOKENS: String(input.budgetTokens),
    PROMPT_TOKENS_ESTIMATE: String(input.estimatedPromptTokens),
    LINE_NUMBERS: input.lineNumbers ? "on" : "off",
    PRIVACY_MODE: input.privacyMode,
    DISCOVERY_BACKEND: input.discoveryBackend,
    DIFF_MODE: input.diffMode,
    TASK: input.task,
    OPEN_QUESTIONS: input.sectionBodies.open_questions ?? "",
    REPO_OVERVIEW: input.sectionBodies.repo_overview ?? "",
    TREE: input.sectionBodies.tree ?? "",
    HANDOFF_SUMMARY: input.sectionBodies.handoff_summary ?? "",
    CODEMAPS: input.sectionBodies.codemaps ?? "",
    FILES: input.sectionBodies.files ?? "",
    GIT_DIFF: input.sectionBodies.git_diff ?? "",
    TOKEN_REPORT: input.sectionBodies.token_report ?? "",
    MANIFEST: input.sectionBodies.manifest ?? "",
  };
}

export async function runMainPipeline(
  options: MainPipelineRunnerOptions,
): Promise<MainPipelineRunnerResult> {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId.trim();
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const phaseStart = performance.now();
  const phaseDurationsMs: Record<string, number> = {};
  const readFileText = createRepoFileReader({
    repoRoot,
    readFileText: options.readFileText,
  });

  const scanStart = performance.now();
  const scan = await walkRepositoryFiles({
    repoRoot,
    maxFileBytes: options.config.repo.maxFileBytes,
    useGitignore: options.config.repo.useGitignore,
    extraIgnorePatterns: options.config.repo.ignore,
    neverIncludeGlobs: options.config.privacy.neverInclude,
    skipBinary: options.config.repo.skipBinary,
  });
  phaseDurationsMs.scan = Math.max(0, Math.round(performance.now() - scanStart));
  if (scan.files.length < 1) {
    throw new Error("No readable files found after repository scan");
  }

  const dbPath =
    options.config.index.enabled && options.config.index.engine === "sqlite"
      ? resolveIndexDatabasePath({ repoRoot })
      : ":memory:";
  const indexHandle = openSqliteIndex({
    dbPath,
    rebuildOnSchemaChange: options.config.index.rebuildOnSchemaChange,
  });

  try {
    const indexStart = performance.now();
    let index: ApplyIncrementalIndexResult;
    if (options.config.index.enabled) {
      index = applyIncrementalIndexUpdate(indexHandle.db, scan.files, {
        hashResolver: (entry) => {
          try {
            return stableHash(readFileText(entry.path));
          } catch {
            return "";
          }
        },
      });
    } else {
      index = {
        upsertedCount: 0,
        touchedCount: 0,
        deletedCount: 0,
        unchangedCount: 0,
        indexedAt: now().toISOString(),
      };
    }
    phaseDurationsMs.index = Math.max(0, Math.round(performance.now() - indexStart));

    const discoveryStart = performance.now();
    const discovery = runOfflineDiscovery({
      db: indexHandle.db,
      task: options.task,
      repoFiles: scan.files,
      readFileText: (pathValue) => readFileText(pathValue),
      maxFullFiles: options.config.defaults.maxFullFiles,
      maxSliceFiles: Math.max(
        options.config.defaults.maxFiles - options.config.defaults.maxFullFiles,
        1,
      ),
      maxCodemapOnlyFiles: options.config.defaults.maxFiles,
      maxFileBytes: options.config.repo.maxFileBytes,
      maxSlicesPerFile: options.config.defaults.maxSlicesPerFile,
      sliceFallbackContextLines: DEFAULT_SLICE_CONTEXT_LINES,
    });
    phaseDurationsMs.discovery = Math.max(
      0,
      Math.round(performance.now() - discoveryStart),
    );

    const filesByPath = new Map(scan.files.map((file) => [file.path, file] as const));
    const selectionManager = new SelectionManager(
      selectionManagerOptionsFromConfig(options.config),
    );
    for (const entry of discovery.selection) {
      const file = filesByPath.get(entry.path);
      selectionManager.add(entry, {
        isBinary: file ? !file.isText : false,
        fileBytes: file?.size,
      });
    }

    if (selectionManager.getAll().length === 0) {
      const fallbackFile = scan.files[0];
      if (fallbackFile) {
        selectionManager.add({
          path: fallbackFile.path,
          mode: "full",
          priority: "core",
          rationale: "fallback selection: first scanned file",
        });
      }
    }

    selectionManager.finalizePriorityScores({
      taskText: options.task,
    });
    const constrained = selectionManager.enforceHardConstraints();
    if (constrained.entries.length < 1) {
      throw new Error("Selection constraints removed all candidate files");
    }

    const budgetStart = performance.now();
    const preBudgetEntries = constrained.entries;
    const codemapDetailByPath = Object.fromEntries(
      preBudgetEntries
        .filter((entry) => entry.mode === "codemap_only")
        .map((entry) => [
          entry.path,
          options.config.defaults.codemaps === "complete" ? "complete" : "summary",
        ] as const),
    );
    const budgetResult = runBudgetNormalizationLoop({
      budgetTokens: options.config.defaults.budgetTokens,
      reserveTokens: options.config.defaults.reserveTokens,
      entries: preBudgetEntries,
      codemapDetailByPath,
      sliceContextLines: DEFAULT_SLICE_CONTEXT_LINES,
      treeVerbosity: toTreeVerbosity(options.config.defaults.treeMode),
      failOnOverbudget: options.failOnOverbudget ?? false,
      estimateBreakdown: (state) => estimateSelectionBreakdown(state, readFileText),
    });
    phaseDurationsMs.budget = Math.max(0, Math.round(performance.now() - budgetStart));
    if (budgetResult.report.shouldFail) {
      throw new Error(
        budgetResult.report.warning ??
          `Estimated prompt tokens ${budgetResult.report.finalEstimate} exceed budget ${budgetResult.report.budget}`,
      );
    }

    const assemblyStart = performance.now();
    const selection = budgetResult.state.entries;
    const selectedPathSet = new Set(selection.map((entry) => entry.path));
    const tokenReport = buildTokenReport(options.config.defaults.budgetTokens, budgetResult.report);
    const metadata: MetadataField[] = [
      { key: "repo_root", value: repoRoot },
      { key: "run_id", value: runId },
      { key: "mode", value: options.config.defaults.mode },
      { key: "discovery_backend", value: "offline" },
      { key: "files_scanned", value: scan.files.length },
      { key: "files_selected", value: selection.length },
    ];
    const sections = renderPromptSections({
      metadata,
      task: options.task,
      openQuestions: discovery.openQuestions,
      repoOverview: {
        languageStats: buildLanguageStats(scan.files),
        indexStatus: options.config.index.enabled
          ? `indexed_files=${scan.files.length}, persistence=enabled`
          : "indexed_files=0, persistence=disabled (using in-memory index)",
        ignoreSummary: {
          gitignorePatterns: options.config.repo.useGitignore ? 1 : 0,
          configIgnores: options.config.repo.ignore.length,
        },
        notes: [
          `oversized_files=${scan.oversized.length}`,
          `excluded_files=${scan.excluded.length}`,
        ],
      },
      tree: buildTreeSection(
        scan.files.map((file) => file.path),
        selectedPathSet,
        budgetResult.state.treeVerbosity,
      ),
      handoffSummary: discovery.handoffSummary,
      codemaps: buildCodemapEntries(selection, filesByPath, readFileText),
      files: buildFilesSectionEntries(selection, readFileText),
      gitDiff: "",
      tokenReport: options.config.output.includeTokenReport ? tokenReport : undefined,
      manifest: options.config.output.includeManifestFooter ? selection : [],
      lineNumbers: options.config.defaults.lineNumbers,
    });
    const sectionBodies = Object.fromEntries(
      sections.map((section) => [section.key, section.body]),
    );
    const template = getTemplateByName(options.config.defaults.mode, repoRoot);
    if (!template) {
      throw new Error(`Template not found: ${options.config.defaults.mode}`);
    }
    const templateValues = sectionsToTemplateValues({
      repoRoot,
      runId,
      budgetTokens: options.config.defaults.budgetTokens,
      estimatedPromptTokens: budgetResult.report.finalEstimate,
      lineNumbers: options.config.defaults.lineNumbers,
      privacyMode: options.config.privacy.mode,
      discoveryBackend: "offline",
      diffMode: String(options.config.git.diff),
      task: options.task,
      sectionBodies,
    });
    const renderedTemplate = renderTemplate(template.body, templateValues).output;
    const prompt =
      options.config.defaults.format === "markdown+xmltags"
        ? renderedTemplate
        : formatPromptOutput(options.config.defaults.format, sections);
    const compiledRedactionPatterns = compileExtraRedactPatterns(
      options.config.privacy.extraRedactPatterns,
    );
    const redactedPrompt = redactText(prompt, {
      enabled: options.config.privacy.redact,
      extraPatterns: compiledRedactionPatterns.patterns,
    });
    phaseDurationsMs.assembly = Math.max(
      0,
      Math.round(performance.now() - assemblyStart),
    );

    const finishedAt = now();
    const runRecord: StoredRunRecord = {
      runId,
      task: options.task,
      config: options.config,
      discovery,
      selection: toSelectionEntries(selection),
      tokenReport,
      timing: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - phaseStart)),
        phaseDurationsMs,
      },
      discoveryBackend: "offline",
      discoveryDurationMs: phaseDurationsMs.discovery,
      startedAt: startedAt.toISOString(),
      completedAt: finishedAt.toISOString(),
    };

    const artifacts = await persistRunArtifacts({
      repoRoot,
      runsDir: options.config.output.runsDir,
      storeRuns: options.config.output.storeRuns,
      runRecord,
      promptText: redactedPrompt.text,
    });

    return {
      runId,
      prompt: redactedPrompt.text,
      promptTokens: estimateTokensFromText(redactedPrompt.text),
      filesScanned: scan.files.length,
      filesSelected: selection.length,
      discoveryBackend: "offline",
      scan,
      index,
      tokenReport,
      selection,
      runRecord,
      artifacts,
    };
  } finally {
    indexHandle.close();
  }
}
