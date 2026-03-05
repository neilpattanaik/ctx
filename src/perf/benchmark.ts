import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runOfflineDiscovery } from "../discovery";
import { openSqliteIndex, applyIncrementalIndexUpdate } from "../index-manager";
import { formatPromptOutput } from "../prompt/output-format";
import {
  renderPromptSections,
  type FilesSectionEntry,
  type FilesSectionSlice,
  type MetadataField,
} from "../prompt/section-renderers";
import { renderTemplate, type TemplateValues } from "../prompt/template-engine";
import { getBuiltInTemplate } from "../prompt/templates";
import { walkRepositoryFiles } from "../scanner";
import {
  runBudgetNormalizationLoop,
  type BudgetDegradationState,
  type BudgetEstimateBreakdown,
  type ManagedSelectionEntry,
} from "../selection";
import { createDefaultCtxConfig } from "../config/schema";
import type { SelectionEntry, TokenReport } from "../types";
import { estimateTokensFromText } from "../utils/token-estimate";

const DEFAULT_SIZES = [100, 500, 2_000, 10_000] as const;
const DEFAULT_ITERATIONS = 1;
const DEFAULT_TASK =
  "Investigate auth login flow, service boundaries, and related configuration knobs.";
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_SLICE_CONTEXT_LINES = 30;
const DEFAULT_COLD_SMALL_TARGET_MS = 8_000;
const DEFAULT_WARM_SMALL_TARGET_MS = 3_000;
const DEFAULT_COLD_LARGE_TARGET_MS = 30_000;
const DEFAULT_WARM_LARGE_TARGET_MS = 10_000;
const DEFAULT_DISCOVERY_TARGET_MS = 2_000;
const DEFAULT_ASSEMBLY_TARGET_MS = 1_000;
const CODEMAP_COMPLETE_TOKENS = 160;
const CODEMAP_SUMMARY_TOKENS = 80;
const ESTIMATED_METADATA_TOKENS = 180;

const FIXTURE_EXTENSIONS = [
  ".ts",
  ".js",
  ".py",
  ".go",
  ".rs",
  ".md",
  ".json",
] as const;

export interface PipelinePhaseTiming {
  scanMs: number;
  indexMs: number;
  discoveryMs: number;
  budgetMs: number;
  assemblyMs: number;
  toDiscoveryMs: number;
  totalMs: number;
  filesScanned: number;
  filesSelected: number;
  estimatedTokens: number;
  promptTokens: number;
}

export interface SizeBenchmarkResult {
  size: number;
  cold: PipelinePhaseTiming;
  warm: PipelinePhaseTiming;
}

export interface BenchmarkTargetThresholds {
  coldToDiscoveryMs: number;
  warmToDiscoveryMs: number;
  discoveryMs: number;
  assemblyMs: number;
}

export interface ScenarioTargetEvaluation {
  scenario: "cold" | "warm";
  pass: boolean;
  failures: string[];
  measured: {
    toDiscoveryMs: number;
    discoveryMs: number;
    assemblyMs: number;
  };
  targets: {
    toDiscoveryMs: number;
    discoveryMs: number;
    assemblyMs: number;
  };
}

export interface SizeTargetEvaluation {
  size: number;
  pass: boolean;
  cold: ScenarioTargetEvaluation;
  warm: ScenarioTargetEvaluation;
}

export interface PerformanceBenchmarkReport {
  generatedAt: string;
  fixturesRoot: string;
  task: string;
  iterations: number;
  thresholds: BenchmarkTargetThresholds;
  results: SizeBenchmarkResult[];
  evaluations: SizeTargetEvaluation[];
  overallPass: boolean;
}

interface BenchmarkCliOptions {
  sizes: number[];
  iterations: number;
  fixturesRoot?: string;
  task: string;
  json: boolean;
  assertTargets: boolean;
}

interface RunPipelineBenchmarkOptions {
  repoRoot: string;
  dbPath: string;
  task: string;
}

interface FixtureFile {
  path: string;
  content: string;
}

function toFixedMs(value: number): number {
  return Number(value.toFixed(2));
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

export function parseBenchmarkSizes(rawValue: string | undefined): number[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [...DEFAULT_SIZES];
  }

  const values = rawValue
    .split(",")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (values.length === 0) {
    throw new Error("--sizes requires one or more comma-separated positive integers");
  }

  const parsedValues = values.map((value) =>
    parsePositiveInteger(value, "--sizes"),
  );
  const deduped = [...new Set(parsedValues)];
  deduped.sort((left, right) => left - right);
  return deduped;
}

export function resolveThresholdsForSize(size: number): BenchmarkTargetThresholds {
  if (size <= 500) {
    return {
      coldToDiscoveryMs: DEFAULT_COLD_SMALL_TARGET_MS,
      warmToDiscoveryMs: DEFAULT_WARM_SMALL_TARGET_MS,
      discoveryMs: DEFAULT_DISCOVERY_TARGET_MS,
      assemblyMs: DEFAULT_ASSEMBLY_TARGET_MS,
    };
  }
  return {
    coldToDiscoveryMs: DEFAULT_COLD_LARGE_TARGET_MS,
    warmToDiscoveryMs: DEFAULT_WARM_LARGE_TARGET_MS,
    discoveryMs: DEFAULT_DISCOVERY_TARGET_MS,
    assemblyMs: DEFAULT_ASSEMBLY_TARGET_MS,
  };
}

function evaluateScenarioTargets(
  scenario: "cold" | "warm",
  timing: PipelinePhaseTiming,
  thresholds: BenchmarkTargetThresholds,
): ScenarioTargetEvaluation {
  const failures: string[] = [];
  const toDiscoveryTarget =
    scenario === "cold" ? thresholds.coldToDiscoveryMs : thresholds.warmToDiscoveryMs;

  if (timing.toDiscoveryMs > toDiscoveryTarget) {
    failures.push(
      `${scenario} to_discovery ${timing.toDiscoveryMs}ms > ${toDiscoveryTarget}ms`,
    );
  }
  if (timing.discoveryMs > thresholds.discoveryMs) {
    failures.push(
      `${scenario} discovery ${timing.discoveryMs}ms > ${thresholds.discoveryMs}ms`,
    );
  }
  if (timing.assemblyMs > thresholds.assemblyMs) {
    failures.push(
      `${scenario} assembly ${timing.assemblyMs}ms > ${thresholds.assemblyMs}ms`,
    );
  }

  return {
    scenario,
    pass: failures.length === 0,
    failures,
    measured: {
      toDiscoveryMs: timing.toDiscoveryMs,
      discoveryMs: timing.discoveryMs,
      assemblyMs: timing.assemblyMs,
    },
    targets: {
      toDiscoveryMs: toDiscoveryTarget,
      discoveryMs: thresholds.discoveryMs,
      assemblyMs: thresholds.assemblyMs,
    },
  };
}

export function evaluateBenchmarkTargets(
  result: SizeBenchmarkResult,
): SizeTargetEvaluation {
  const thresholds = resolveThresholdsForSize(result.size);
  const cold = evaluateScenarioTargets("cold", result.cold, thresholds);
  const warm = evaluateScenarioTargets("warm", result.warm, thresholds);

  return {
    size: result.size,
    pass: cold.pass && warm.pass,
    cold,
    warm,
  };
}

function parseBenchmarkArgs(argv: string[]): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    sizes: [...DEFAULT_SIZES],
    iterations: DEFAULT_ITERATIONS,
    task: DEFAULT_TASK,
    json: false,
    assertTargets: process.env.CTX_BENCHMARK_ENFORCE === "1",
  };

  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      throw new Error("HELP");
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--assert-targets" || token === "--enforce-targets") {
      options.assertTargets = true;
      continue;
    }
    if (token === "--sizes") {
      options.sizes = parseBenchmarkSizes(readValue(index, "--sizes"));
      index += 1;
      continue;
    }
    if (token.startsWith("--sizes=")) {
      options.sizes = parseBenchmarkSizes(token.slice("--sizes=".length));
      continue;
    }
    if (token === "--iterations") {
      options.iterations = parsePositiveInteger(
        readValue(index, "--iterations"),
        "--iterations",
      );
      index += 1;
      continue;
    }
    if (token.startsWith("--iterations=")) {
      options.iterations = parsePositiveInteger(
        token.slice("--iterations=".length),
        "--iterations",
      );
      continue;
    }
    if (token === "--fixtures-root") {
      options.fixturesRoot = readValue(index, "--fixtures-root");
      index += 1;
      continue;
    }
    if (token.startsWith("--fixtures-root=")) {
      options.fixturesRoot = token.slice("--fixtures-root=".length);
      continue;
    }
    if (token === "--task") {
      options.task = readValue(index, "--task");
      index += 1;
      continue;
    }
    if (token.startsWith("--task=")) {
      options.task = token.slice("--task=".length);
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

function normalizeRepoPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function filePathForFixture(index: number, extension: string): string {
  const group = Math.floor(index / 100);
  const layer = Math.floor(index / 25) % 4;
  const basename = `file_${String(index).padStart(5, "0")}${extension}`;
  return `src/group_${group}/layer_${layer}/${basename}`;
}

function toImportSpecifier(fromPath: string, toPath: string): string {
  const fromDirectory = dirname(fromPath);
  const relativePath = relative(fromDirectory, toPath).replace(/\\/g, "/");
  const withoutExtension = relativePath.endsWith(".ts")
    ? relativePath.slice(0, -3)
    : relativePath;
  return withoutExtension.startsWith(".")
    ? withoutExtension
    : `./${withoutExtension}`;
}

function buildSpecialFixtureFiles(): readonly FixtureFile[] {
  const loginPath = "src/auth/login.ts";
  const servicePath = "src/auth/service.ts";
  const configPath = "src/config/auth-config.ts";

  return [
    {
      path: "src/main.ts",
      content: [
        `import { login } from "${toImportSpecifier("src/main.ts", loginPath)}";`,
        `import { authService } from "${toImportSpecifier("src/main.ts", servicePath)}";`,
        "export function main(user: string): string {",
        "  const token = login(user);",
        "  return authService(token);",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: loginPath,
      content: [
        `import { authConfig } from "${toImportSpecifier(loginPath, configPath)}";`,
        "export function login(user: string): string {",
        "  return `${user}:${authConfig.provider}:${authConfig.retries}`;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: servicePath,
      content: [
        `import { authConfig } from "${toImportSpecifier(servicePath, configPath)}";`,
        "export function authService(token: string): string {",
        "  return `${authConfig.provider}:${token}`;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: configPath,
      content: [
        "export const authConfig = {",
        "  provider: \"oauth\",",
        "  retries: 3,",
        "  timeoutMs: 1000,",
        "};",
        "",
      ].join("\n"),
    },
    {
      path: "test/auth/login.test.ts",
      content: [
        `import { login } from "${toImportSpecifier("test/auth/login.test.ts", loginPath)}";`,
        "if (login(\"user\").length === 0) {",
        "  throw new Error(\"login returned empty token\");",
        "}",
        "",
      ].join("\n"),
    },
  ];
}

function buildSyntheticFileContent(
  index: number,
  extension: string,
  fileCount: number,
): string {
  const previousIndex = index > 0 ? index - 1 : 0;
  switch (extension) {
    case ".ts":
    case ".js":
      return [
        `// synthetic fixture file ${index}/${fileCount}`,
        `export function file_${index}_handler(input: string): string {`,
        `  const previous = "file_${previousIndex}_handler";`,
        "  return `${previous}:${input}`;",
        "}",
        "",
      ].join("\n");
    case ".py":
      return [
        `# synthetic fixture file ${index}/${fileCount}`,
        `def file_${index}_handler(input_text: str) -> str:`,
        `    previous = "file_${previousIndex}_handler"`,
        "    return f\"{previous}:{input_text}\"",
        "",
      ].join("\n");
    case ".go":
      return [
        "package fixture",
        "",
        `func File${index}Handler(input string) string {`,
        `\tprevious := "File${previousIndex}Handler"`,
        "\treturn previous + \":\" + input",
        "}",
        "",
      ].join("\n");
    case ".rs":
      return [
        `pub fn file_${index}_handler(input: &str) -> String {`,
        `    let previous = "file_${previousIndex}_handler";`,
        "    format!(\"{}:{}\", previous, input)",
        "}",
        "",
      ].join("\n");
    case ".md":
      return [
        `# Fixture Document ${index}`,
        "",
        `This synthetic markdown file belongs to fixture size ${fileCount}.`,
        `It references handler file_${previousIndex}_handler for search density.`,
        "",
      ].join("\n");
    case ".json":
    default:
      return JSON.stringify(
        {
          file: index,
          size: fileCount,
          handler: `file_${previousIndex}_handler`,
        },
        null,
        2,
      );
  }
}

function createFixtureRepository(repoRoot: string, fileCount: number): void {
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    resolve(repoRoot, ".gitignore"),
    [".ctx/", "node_modules/"].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(repoRoot, "package.json"),
    JSON.stringify({ name: `ctx-bench-${fileCount}`, private: true }, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(repoRoot, "README.md"),
    `# synthetic benchmark fixture (${fileCount} files)\n`,
    "utf8",
  );

  const specialFiles = buildSpecialFixtureFiles();
  const generatedCount = Math.max(0, fileCount - specialFiles.length);

  for (let index = 0; index < fileCount; index += 1) {
    const special = specialFiles[index];
    if (special) {
      const absolutePath = resolve(repoRoot, special.path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, special.content, "utf8");
      continue;
    }

    const generatedIndex = index - specialFiles.length;
    const extension =
      FIXTURE_EXTENSIONS[generatedIndex % FIXTURE_EXTENSIONS.length] ?? ".ts";
    const relativePath = filePathForFixture(generatedIndex, extension);
    const absolutePath = resolve(repoRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      buildSyntheticFileContent(generatedIndex, extension, generatedCount),
      "utf8",
    );
  }
}

function createFileReader(repoRoot: string): (pathValue: string) => string {
  const cache = new Map<string, string>();
  return (pathValue: string): string => {
    const normalized = normalizeRepoPath(pathValue);
    const cached = cache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    const absolutePath = resolve(repoRoot, normalized);
    const text = readFileSync(absolutePath, "utf8");
    cache.set(normalized, text);
    return text;
  };
}

function toManagedSelection(
  entries: readonly SelectionEntry[],
): ManagedSelectionEntry[] {
  return entries.map((entry) => ({
    ...entry,
    priorityScore:
      entry.priority === "core" ? 300 : entry.priority === "support" ? 200 : 100,
  }));
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
  const files = entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));

  return files.map((entry) => {
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
      reason: degradation.targetPath
        ? `target=${degradation.targetPath}`
        : "global",
      delta: degradation.tokensSaved,
    })),
  };
}

function sectionsToTemplateValues(
  repoRoot: string,
  budgetTokens: number,
  estimatedPromptTokens: number,
  task: string,
  sectionBodies: Record<string, string>,
): TemplateValues {
  return {
    REPO_ROOT: repoRoot,
    RUN_ID: "benchmark",
    BUDGET_TOKENS: String(budgetTokens),
    PROMPT_TOKENS_ESTIMATE: String(estimatedPromptTokens),
    LINE_NUMBERS: "off",
    PRIVACY_MODE: "normal",
    DISCOVERY_BACKEND: "offline",
    DIFF_MODE: "off",
    TASK: task,
    OPEN_QUESTIONS: sectionBodies.open_questions ?? "",
    REPO_OVERVIEW: sectionBodies.repo_overview ?? "",
    TREE: sectionBodies.tree ?? "",
    HANDOFF_SUMMARY: sectionBodies.handoff_summary ?? "",
    CODEMAPS: sectionBodies.codemaps ?? "",
    FILES: sectionBodies.files ?? "",
    GIT_DIFF: sectionBodies.git_diff ?? "",
    TOKEN_REPORT: sectionBodies.token_report ?? "",
    MANIFEST: sectionBodies.manifest ?? "",
  };
}

async function runPipelineBenchmark(
  options: RunPipelineBenchmarkOptions,
): Promise<PipelinePhaseTiming> {
  const config = createDefaultCtxConfig();
  const readFileText = createFileReader(options.repoRoot);
  const totalStart = performance.now();

  const scanStart = performance.now();
  const scanResult = await walkRepositoryFiles({
    repoRoot: options.repoRoot,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    useGitignore: false,
    skipBinary: true,
  });
  const scanMs = toFixedMs(performance.now() - scanStart);

  const indexHandle = openSqliteIndex({
    dbPath: options.dbPath,
    rebuildOnSchemaChange: true,
  });

  try {
    const indexStart = performance.now();
    applyIncrementalIndexUpdate(indexHandle.db, scanResult.files);
    const indexMs = toFixedMs(performance.now() - indexStart);

    const discoveryStart = performance.now();
    const discoveryResult = runOfflineDiscovery({
      db: indexHandle.db,
      task: options.task,
      repoFiles: scanResult.files,
      readFileText: (pathValue) => readFileText(pathValue),
      maxFullFiles: config.defaults.maxFullFiles,
      maxSliceFiles: Math.max(config.defaults.maxFiles - config.defaults.maxFullFiles, 1),
      maxCodemapOnlyFiles: config.defaults.maxFiles,
      maxFileBytes: config.repo.maxFileBytes,
      maxSlicesPerFile: config.defaults.maxSlicesPerFile,
      sliceFallbackContextLines: DEFAULT_SLICE_CONTEXT_LINES,
    });
    const discoveryMs = toFixedMs(performance.now() - discoveryStart);

    const budgetStart = performance.now();
    const managedSelection = toManagedSelection(discoveryResult.selection);
    const codemapDetailByPath = Object.fromEntries(
      managedSelection
        .filter((entry) => entry.mode === "codemap_only")
        .map((entry) => [entry.path, "complete"] as const),
    );
    const budgetResult = runBudgetNormalizationLoop({
      budgetTokens: config.defaults.budgetTokens,
      reserveTokens: config.defaults.reserveTokens,
      entries: managedSelection,
      codemapDetailByPath,
      sliceContextLines: DEFAULT_SLICE_CONTEXT_LINES,
      treeVerbosity: "selected",
      estimateBreakdown: (state) => estimateSelectionBreakdown(state, readFileText),
    });
    const budgetMs = toFixedMs(performance.now() - budgetStart);

    const assemblyStart = performance.now();
    const filesSectionEntries = buildFilesSectionEntries(
      budgetResult.state.entries,
      readFileText,
    );
    const metadata: MetadataField[] = [
      { key: "repo_root", value: options.repoRoot },
      { key: "discovery_backend", value: "offline" },
      { key: "files_scanned", value: scanResult.files.length },
      { key: "files_selected", value: budgetResult.state.entries.length },
    ];
    const tokenReport = buildTokenReport(config.defaults.budgetTokens, budgetResult.report);
    const sections = renderPromptSections({
      metadata,
      task: options.task,
      openQuestions: discoveryResult.openQuestions,
      repoOverview: {
        languageStats: buildLanguageStats(scanResult.files),
        notes: [
          `oversized_files=${scanResult.oversized.length}`,
          `excluded_files=${scanResult.excluded.length}`,
        ],
      },
      handoffSummary: discoveryResult.handoffSummary,
      files: filesSectionEntries,
      tokenReport,
      manifest: budgetResult.state.entries,
      lineNumbers: false,
    });
    const sectionBodies = Object.fromEntries(
      sections.map((section) => [section.key, section.body]),
    );
    const templateValues = sectionsToTemplateValues(
      options.repoRoot,
      config.defaults.budgetTokens,
      budgetResult.report.finalEstimate,
      options.task,
      sectionBodies,
    );
    const renderedPrompt = renderTemplate(
      getBuiltInTemplate("plan"),
      templateValues,
    ).output;
    const formattedPrompt = formatPromptOutput(
      config.defaults.format,
      [{ key: "prompt", title: "Prompt", body: renderedPrompt }],
      { includeMarkers: false },
    );
    const assemblyMs = toFixedMs(performance.now() - assemblyStart);
    const totalMs = toFixedMs(performance.now() - totalStart);

    return {
      scanMs,
      indexMs,
      discoveryMs,
      budgetMs,
      assemblyMs,
      toDiscoveryMs: toFixedMs(scanMs + indexMs + discoveryMs),
      totalMs,
      filesScanned: scanResult.files.length,
      filesSelected: budgetResult.state.entries.length,
      estimatedTokens: budgetResult.report.finalEstimate,
      promptTokens: estimateTokensFromText(formattedPrompt),
    };
  } finally {
    indexHandle.close();
  }
}

function averageTimings(samples: readonly PipelinePhaseTiming[]): PipelinePhaseTiming {
  const divisor = samples.length;
  const average = (pick: (sample: PipelinePhaseTiming) => number): number =>
    toFixedMs(samples.reduce((sum, sample) => sum + pick(sample), 0) / divisor);

  return {
    scanMs: average((sample) => sample.scanMs),
    indexMs: average((sample) => sample.indexMs),
    discoveryMs: average((sample) => sample.discoveryMs),
    budgetMs: average((sample) => sample.budgetMs),
    assemblyMs: average((sample) => sample.assemblyMs),
    toDiscoveryMs: average((sample) => sample.toDiscoveryMs),
    totalMs: average((sample) => sample.totalMs),
    filesScanned: Math.round(average((sample) => sample.filesScanned)),
    filesSelected: Math.round(average((sample) => sample.filesSelected)),
    estimatedTokens: Math.round(average((sample) => sample.estimatedTokens)),
    promptTokens: Math.round(average((sample) => sample.promptTokens)),
  };
}

function formatTableCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function formatBenchmarkTable(report: PerformanceBenchmarkReport): string {
  const headers = [
    "size",
    "scenario",
    "scan_ms",
    "index_ms",
    "discovery_ms",
    "budget_ms",
    "assembly_ms",
    "to_discovery_ms",
    "total_ms",
    "target",
    "pass",
  ];
  const rows: string[][] = [];
  const evaluationBySize = new Map(
    report.evaluations.map((evaluation) => [evaluation.size, evaluation] as const),
  );

  for (const result of report.results) {
    const evaluation = evaluationBySize.get(result.size);
    if (!evaluation) {
      continue;
    }

    const scenarios: Array<{
      name: "cold" | "warm";
      timing: PipelinePhaseTiming;
      target: number;
      pass: boolean;
    }> = [
      {
        name: "cold",
        timing: result.cold,
        target: evaluation.cold.targets.toDiscoveryMs,
        pass: evaluation.cold.pass,
      },
      {
        name: "warm",
        timing: result.warm,
        target: evaluation.warm.targets.toDiscoveryMs,
        pass: evaluation.warm.pass,
      },
    ];

    for (const scenario of scenarios) {
      rows.push([
        String(result.size),
        scenario.name,
        String(scenario.timing.scanMs),
        String(scenario.timing.indexMs),
        String(scenario.timing.discoveryMs),
        String(scenario.timing.budgetMs),
        String(scenario.timing.assemblyMs),
        String(scenario.timing.toDiscoveryMs),
        String(scenario.timing.totalMs),
        `<${scenario.target}`,
        scenario.pass ? "PASS" : "FAIL",
      ]);
    }
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");

  const headerRow = headers
    .map((header, index) => formatTableCell(header, widths[index] ?? header.length))
    .join(" | ");
  const bodyRows = rows.map((row) =>
    row
      .map((value, index) => formatTableCell(value, widths[index] ?? value.length))
      .join(" | "),
  );

  return [headerRow, separator, ...bodyRows].join("\n");
}

export async function runPerformanceBenchmarks(
  options: BenchmarkCliOptions,
): Promise<PerformanceBenchmarkReport> {
  const fixturesRoot = options.fixturesRoot
    ? resolve(options.fixturesRoot)
    : mkdtempSync(`${tmpdir()}/ctx-perf-bench-`);
  mkdirSync(fixturesRoot, { recursive: true });

  const results: SizeBenchmarkResult[] = [];
  for (const size of options.sizes) {
    const coldSamples: PipelinePhaseTiming[] = [];
    const warmSamples: PipelinePhaseTiming[] = [];

    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const repoRoot = resolve(fixturesRoot, `repo-${size}-iter-${iteration}`);
      const dbPath = resolve(repoRoot, ".ctx", "index.db");
      createFixtureRepository(repoRoot, size);

      console.error(
        `[bench] size=${size} iteration=${iteration}/${options.iterations}: cold`,
      );
      const cold = await runPipelineBenchmark({
        repoRoot,
        dbPath,
        task: options.task,
      });
      coldSamples.push(cold);

      console.error(
        `[bench] size=${size} iteration=${iteration}/${options.iterations}: warm`,
      );
      const warm = await runPipelineBenchmark({
        repoRoot,
        dbPath,
        task: options.task,
      });
      warmSamples.push(warm);
    }

    results.push({
      size,
      cold: averageTimings(coldSamples),
      warm: averageTimings(warmSamples),
    });
  }

  const evaluations = results.map((result) => evaluateBenchmarkTargets(result));
  const overallPass = evaluations.every((evaluation) => evaluation.pass);

  return {
    generatedAt: new Date().toISOString(),
    fixturesRoot,
    task: options.task,
    iterations: options.iterations,
    thresholds: {
      coldToDiscoveryMs: DEFAULT_COLD_LARGE_TARGET_MS,
      warmToDiscoveryMs: DEFAULT_WARM_LARGE_TARGET_MS,
      discoveryMs: DEFAULT_DISCOVERY_TARGET_MS,
      assemblyMs: DEFAULT_ASSEMBLY_TARGET_MS,
    },
    results,
    evaluations,
    overallPass,
  };
}

function renderHelp(): string {
  return [
    "ctx performance benchmark runner",
    "",
    "Usage:",
    "  bun run src/perf/benchmark.ts [options]",
    "",
    "Options:",
    "  --sizes <csv>            Comma-separated file counts (default: 100,500,2000,10000)",
    "  --iterations <n>         Iterations per size; averaged (default: 1)",
    "  --task <text>            Discovery task text",
    "  --fixtures-root <path>   Directory for generated fixture repositories",
    "  --json                   Emit machine-readable JSON report",
    "  --assert-targets         Exit 1 when benchmark targets are missed",
    "  --enforce-targets        Alias for --assert-targets",
    "  --help                   Show this help text",
  ].join("\n");
}

export async function runBenchmarkCli(argv: string[]): Promise<number> {
  let options: BenchmarkCliOptions;
  try {
    options = parseBenchmarkArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      console.log(renderHelp());
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Use --help for options.");
    return 2;
  }

  const report = await runPerformanceBenchmarks(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatBenchmarkTable(report));
    for (const evaluation of report.evaluations) {
      if (evaluation.pass) {
        continue;
      }
      console.log(`size ${evaluation.size} target failures:`);
      for (const failure of [...evaluation.cold.failures, ...evaluation.warm.failures]) {
        console.log(`- ${failure}`);
      }
    }
    console.log(`overall: ${report.overallPass ? "PASS" : "FAIL"}`);
    console.log(`fixtures_root: ${report.fixturesRoot}`);
  }

  if (options.assertTargets && !report.overallPass) {
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const exitCode = await runBenchmarkCli(process.argv.slice(2));
  process.exit(exitCode);
}
