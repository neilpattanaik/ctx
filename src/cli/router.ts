import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildManifestReport,
  formatExplainReport,
  formatManifestReport,
  loadRunRecordForExplain,
  loadRunRecordForManifest,
} from "../artifacts";
import {
  mergeConfigPrecedence,
  parseEnvOverrides,
  parseRepoConfigFile,
  parseUserConfigFile,
  type PartialCtxConfig,
} from "../config";
import { runOfflineDiscovery } from "../discovery";
import {
  formatPromptOutput,
  getTemplateByName,
  listAvailableTemplates,
  renderPromptSections,
  renderTemplate,
  type FilesSectionEntry,
  type MetadataField,
  type PromptTemplateRecord,
  type RepoOverviewSectionInput,
} from "../prompt";
import { compileExtraRedactPatterns, redactText } from "../privacy";
import { detectRepoRoot, RepoRootError } from "../scanner/repo-root";
import { createGitignoreMatcher } from "../scanner/gitignore";
import { isBinaryFile } from "../scanner/binary-detect";
import {
  INDEX_SCHEMA_VERSION,
  applyIncrementalIndexUpdate,
  initializeIndexSchema,
  openSqliteIndex,
  resolveIndexDatabasePath,
} from "../index-manager";
import { extractTaskTerms } from "../discovery/task-terms";
import { collectGitStatus, executeDiffMode } from "../git";
import {
  runBudgetNormalizationLoop,
  type ManagedSelectionEntry,
  SelectionManager,
  selectionManagerOptionsFromConfig,
  type BudgetDegradationState,
  type BudgetEstimateBreakdown,
  type CodemapDetail,
  type TreeVerbosity,
} from "../selection";
import { executeFileTree } from "../tools/tree-tools";
import {
  type CtxConfig,
  type DiscoveryResult,
  createRunRecord,
  type FileEntry,
  type SelectionEntry,
  type TokenReport,
} from "../types";
import { generateRunId } from "../utils/deterministic";
import { matchGlob } from "../utils/paths";
import { estimateTokensFromText } from "../utils/token-estimate";
import { CliStderrReporter } from "./stderr-output";
import type {
  ParsedAgentsCommand,
  ParsedCommand,
  ParsedExplainCommand,
  ParsedIndexCommand,
  ParsedInitCommand,
  CliOptions,
  ParsedMainCommand,
  ParsedManifestCommand,
  ParsedOpenCommand,
  ParsedTemplatesCommand,
} from "./parse-args";

const INIT_CONFIG_TEMPLATE = `# ctx configuration template
# Values shown here document the default shape.

[defaults]
# mode = "plan"
# format = "markdown+xmltags"
# budget_tokens = 60000
# reserve_tokens = 2000
# max_files = 60
# max_full_files = 12
# max_slices_per_file = 6

[repo]
# use_gitignore = true
# max_file_bytes = 1500000
# skip_binary = true
# ignore = []

[discovery]
# discover = "auto"
# provider = "openai"
# model = "gpt-4o-mini"
# timeout_seconds = 45
# max_turns = 8
`;

const DRY_RUN_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".ctx",
  "dist",
]);
const DRY_RUN_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
]);
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_BUDGET_TOKENS = 60_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const DRY_RUN_FILE_SAMPLE_LIMIT = 12;
const DRY_RUN_LIKELY_FILE_LIMIT = 12;
const TREE_FULL_LIMIT = 400;
const TREE_SELECTED_LIMIT = 200;
const DEFAULT_CODEMAP_TOKENS_COMPLETE = 220;
const DEFAULT_CODEMAP_TOKENS_SUMMARY = 120;

const PIPELINE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
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
  ".tsx": "typescriptreact",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export interface CliRuntime {
  stdout(message: string): void;
  stderr(message: string): void;
  isStdinTty(): boolean;
  readStdin(): string;
  readFile(path: string): string;
  readLink(path: string): string;
  writeFile(path: string, contents: string): void;
  copyToClipboard(contents: string): { ok: true } | { ok: false; error: string };
  openInPager(
    absolutePath: string,
    pagerCommand: string,
  ): { ok: true } | { ok: false; error: string };
}

interface DryRunScanFile {
  path: string;
  size: number;
  mtime: number;
  language: string;
}

interface DryRunScanSummary {
  files: DryRunScanFile[];
  excludedBySize: number;
  excludedByBinary: number;
}

interface DryRunLikelyFile {
  path: string;
  size: number;
}

function normalizeRepoPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function fileExtension(pathValue: string): string {
  const index = pathValue.lastIndexOf(".");
  if (index < 0) {
    return "";
  }
  return pathValue.slice(index).toLowerCase();
}

function detectPipelineLanguage(pathValue: string): string {
  return PIPELINE_LANGUAGE_BY_EXTENSION[extname(pathValue).toLowerCase()] ?? "text";
}

function scanFilesForDryRun(
  repoRoot: string,
  maxFileBytes: number,
  options?: {
    skipBinary?: boolean;
  },
): DryRunScanSummary {
  const skipBinary = options?.skipBinary ?? true;
  const files: DryRunScanFile[] = [];
  let excludedBySize = 0;
  let excludedByBinary = 0;
  const stack: string[] = [repoRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let dirEntries: string[];
    try {
      dirEntries = readdirSync(current).sort((left, right) => left.localeCompare(right));
    } catch {
      continue;
    }

    for (const entryName of dirEntries) {
      const absolutePath = resolve(current, entryName);
      const relativePath = normalizeRepoPath(relative(repoRoot, absolutePath));
      if (!relativePath || relativePath === ".") {
        continue;
      }

      let stats;
      try {
        stats = statSync(absolutePath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (DRY_RUN_SKIP_DIRECTORIES.has(entryName)) {
          continue;
        }
        stack.push(absolutePath);
        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      if (stats.size > maxFileBytes) {
        excludedBySize += 1;
        continue;
      }

      if (skipBinary && DRY_RUN_BINARY_EXTENSIONS.has(fileExtension(relativePath))) {
        excludedByBinary += 1;
        continue;
      }

      files.push({
        path: relativePath,
        size: stats.size,
        mtime: stats.mtimeMs,
        language: detectPipelineLanguage(relativePath),
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    excludedBySize,
    excludedByBinary,
  };
}

function countPathHits(pathValue: string, terms: readonly string[]): number {
  const lowerPath = pathValue.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (term.length < 2) {
      continue;
    }
    if (lowerPath.includes(term.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function rankLikelyDryRunFiles(
  files: readonly DryRunScanFile[],
  task: string,
): DryRunLikelyFile[] {
  const terms = extractTaskTerms(task).searchTerms;
  const ranked = files.map((file) => {
    const pathHits = countPathHits(file.path, terms);
    const entrypointBoost = /(^|\/)(main|index|app|server|routes?|cli)\.[a-z0-9]+$/i.test(
      file.path,
    )
      ? 1
      : 0;
    return {
      ...file,
      score: pathHits * 10 + entrypointBoost,
    };
  });

  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });

  return ranked
    .filter((entry) => entry.score > 0)
    .slice(0, DRY_RUN_LIKELY_FILE_LIMIT)
    .map(({ path, size }) => ({ path, size }));
}

function formatDryRunPlan(input: {
  task: string;
  options: CliOptions;
  repoRoot: string;
  scan: DryRunScanSummary;
}): string {
  const budget = input.options.budget ?? DEFAULT_BUDGET_TOKENS;
  const estimatedTokens = Math.ceil(
    input.scan.files.reduce((sum, file) => sum + file.size, 0) / ESTIMATED_CHARS_PER_TOKEN,
  );
  const budgetUtilization =
    budget > 0 ? Math.min(100, Math.round((estimatedTokens / budget) * 100)) : 0;
  const likelyFiles = rankLikelyDryRunFiles(input.scan.files, input.task);
  const fileSamples = input.scan.files
    .slice(0, DRY_RUN_FILE_SAMPLE_LIMIT)
    .map((file) => `- ${file.path} (${file.size} bytes)`);

  const modeSource = input.options.mode ? "cli" : "default";
  const budgetSource = input.options.budget !== undefined ? "cli" : "default";
  const repoSource = input.options.repo ? "cli" : "cwd";
  const maxFileBytesSource = input.options.maxFileBytes !== undefined ? "cli" : "default";

  return [
    "DRY RUN PLAN",
    "",
    `task: ${input.task}`,
    `repo_root: ${input.repoRoot}`,
    "discovery_backend: offline (dry-run override)",
    "",
    "scan_summary:",
    `- files_scanned: ${input.scan.files.length}`,
    `- excluded_by_size_limit: ${input.scan.excludedBySize}`,
    `- excluded_by_binary_extension: ${input.scan.excludedByBinary}`,
    "- sample_files:",
    ...(fileSamples.length > 0 ? fileSamples : ["- none"]),
    "",
    "budget_estimate:",
    `- budget_tokens: ${budget}`,
    `- estimated_tokens_from_scan: ${estimatedTokens}`,
    `- estimated_budget_utilization: ${budgetUtilization}%`,
    "",
    "likely_includes_offline:",
    ...(likelyFiles.length > 0
      ? likelyFiles.map((file) => `- ${file.path} (${file.size} bytes)`)
      : ["- none (no task-term path matches)"]),
    "",
    "config_summary:",
    `- mode: ${input.options.mode ?? "plan"} (source: ${modeSource})`,
    `- budget: ${budget} (source: ${budgetSource})`,
    `- repo: ${input.repoRoot} (source: ${repoSource})`,
    `- max_file_bytes: ${input.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES} (source: ${maxFileBytesSource})`,
    `- discover: offline (source: dry-run override)`,
    "- dry_run: true (source: cli)",
  ].join("\n");
}

function copyViaCommand(
  command: string,
  args: string[],
  contents: string,
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(command, args, {
    input: contents,
    encoding: "utf8",
  });
  if (!result.error && result.status === 0) {
    return { ok: true };
  }

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return { ok: false, error: `command not found: ${command}` };
  }

  const stderr = result.stderr?.trim();
  if (stderr.length > 0) {
    return { ok: false, error: `${command} failed: ${stderr}` };
  }
  return { ok: false, error: `${command} failed` };
}

function defaultCopyToClipboard(
  contents: string,
): { ok: true } | { ok: false; error: string } {
  const platform = process.platform;
  const attempts =
    platform === "darwin"
      ? [{ command: "pbcopy", args: [] as string[] }]
      : platform === "win32"
        ? [{ command: "clip", args: [] as string[] }]
        : [
            { command: "xclip", args: ["-selection", "clipboard"] },
            { command: "xsel", args: ["--clipboard", "--input"] },
          ];

  let lastError = "clipboard copy failed";
  for (const attempt of attempts) {
    const result = copyViaCommand(attempt.command, attempt.args, contents);
    if (result.ok) {
      return result;
    }
    lastError = result.error;
  }

  return { ok: false, error: lastError };
}

function defaultOpenInPager(
  absolutePath: string,
  pagerCommand: string,
): { ok: true } | { ok: false; error: string } {
  const tokens = pagerCommand
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const command = tokens[0];
  if (!command) {
    return { ok: false, error: "pager command is empty" };
  }
  const args = tokens.slice(1);
  const result = spawnSync(command, [...args, absolutePath], {
    stdio: "inherit",
  });

  if (!result.error && result.status === 0) {
    return { ok: true };
  }

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return { ok: false, error: `command not found: ${command}` };
  }

  const stderr = result.stderr?.toString().trim();
  if (stderr && stderr.length > 0) {
    return { ok: false, error: `${command} failed: ${stderr}` };
  }
  return { ok: false, error: `${command} failed` };
}

function writeOutputFile(
  outputPath: string,
  text: string,
  runtime: CliRuntime,
): { ok: true } | { ok: false; error: string } {
  const resolvedOutputPath = resolve(process.cwd(), outputPath);
  try {
    if (runtime.readFile(resolvedOutputPath).trim().length > 0) {
      runtime.stderr(
        `Warning: output file '${outputPath}' exists and will be overwritten.`,
      );
    }
  } catch {
    // Non-existent files are expected for fresh output paths.
  }

  try {
    runtime.writeFile(resolvedOutputPath, text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function routePromptOutput(
  text: string,
  options: CliOptions,
  runtime: CliRuntime,
): number {
  const outputPath = options.output?.trim();
  let wroteFile = false;
  if (outputPath && outputPath.length > 0) {
    const writeResult = writeOutputFile(outputPath, text, runtime);
    if (!writeResult.ok) {
      runtime.stderr(`Failed to write output file '${outputPath}': ${writeResult.error}`);
      return 3;
    }
    wroteFile = true;
  }

  if (options.copy) {
    const copyResult = runtime.copyToClipboard(text);
    if (!copyResult.ok) {
      runtime.stderr(`Warning: ${copyResult.error}; falling back to stdout.`);
      if (!wroteFile) {
        runtime.stdout(text);
      }
      return 0;
    }
    return 0;
  }

  if (!wroteFile) {
    runtime.stdout(text);
  }
  return 0;
}

function formatTemplateSource(
  template: PromptTemplateRecord,
  repoRoot: string,
): string {
  if (template.source === "built_in") {
    return "built-in";
  }

  if (!template.path) {
    return "custom";
  }

  const repoRootResolved = resolve(repoRoot);
  const templatePathResolved = resolve(template.path);
  const relativePath = relative(repoRootResolved, templatePathResolved).replace(
    /\\/g,
    "/",
  );
  if (relativePath.length > 0 && !relativePath.startsWith("..")) {
    return relativePath;
  }
  return template.path;
}

function formatTemplatesListOutput(
  templates: readonly PromptTemplateRecord[],
  repoRoot: string,
): string {
  const rows = templates.map((template) => ({
    name: template.name,
    source: formatTemplateSource(template, repoRoot),
    description: template.description,
  }));

  const nameWidth = Math.max("NAME".length, ...rows.map((row) => row.name.length));
  const sourceWidth = Math.max(
    "SOURCE".length,
    ...rows.map((row) => row.source.length),
  );
  const pad = (value: string, width: number) => value.padEnd(width, " ");

  return [
    `${pad("NAME", nameWidth)}  ${pad("SOURCE", sourceWidth)}  DESCRIPTION`,
    ...rows.map(
      (row) =>
        `${pad(row.name, nameWidth)}  ${pad(row.source, sourceWidth)}  ${row.description}`,
    ),
  ].join("\n");
}

interface MainPipelineSummary {
  mode: string;
  discoveryBackend: string;
  filesScanned: number;
  filesSelected: number;
  budget: number;
  estimatedTokens: number;
  degradationsApplied: number;
}

function applyPromptRedaction(
  promptText: string,
  privacyConfig: CtxConfig["privacy"],
): {
  text: string;
  redactionCount: number;
  invalidPatterns: string[];
} {
  const compiled = compileExtraRedactPatterns(privacyConfig.extraRedactPatterns);
  const redacted = redactText(promptText, {
    enabled: privacyConfig.redact,
    extraPatterns: compiled.patterns,
  });
  return {
    text: redacted.text,
    redactionCount: redacted.redactionCount,
    invalidPatterns: compiled.invalidPatterns,
  };
}

type MainPipelineResult =
  | {
      ok: true;
      promptText: string;
      summary: MainPipelineSummary;
    }
  | {
      ok: false;
      exitCode: number;
      error: string;
      summary: MainPipelineSummary;
    };

function buildMainSummaryDefaults(options: CliOptions): MainPipelineSummary {
  return {
    mode: options.mode ?? "plan",
    discoveryBackend: resolveDiscoveryBackendLabel(options),
    filesScanned: 0,
    filesSelected: 0,
    budget: options.budget ?? DEFAULT_BUDGET_TOKENS,
    estimatedTokens: 0,
    degradationsApplied: 0,
  };
}

function optionsBool(value: "on" | "off" | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "on";
}

function buildCliConfigOverrides(options: CliOptions): PartialCtxConfig {
  const overrides: PartialCtxConfig = {};

  const defaults: NonNullable<PartialCtxConfig["defaults"]> = {};
  if (options.mode) defaults.mode = options.mode;
  if (options.format) defaults.format = options.format;
  if (options.budget !== undefined) defaults.budgetTokens = options.budget;
  if (options.reserve !== undefined) defaults.reserveTokens = options.reserve;
  if (options.maxFiles !== undefined) defaults.maxFiles = options.maxFiles;
  if (options.maxFullFiles !== undefined) defaults.maxFullFiles = options.maxFullFiles;
  if (options.maxSlicesPerFile !== undefined) {
    defaults.maxSlicesPerFile = options.maxSlicesPerFile;
  }
  if (options.tree) defaults.treeMode = options.tree;
  if (options.codemaps) defaults.codemaps = options.codemaps;
  const lineNumbers = optionsBool(options.lineNumbers);
  if (lineNumbers !== undefined) defaults.lineNumbers = lineNumbers;
  if (Object.keys(defaults).length > 0) {
    overrides.defaults = defaults;
  }

  const repo: NonNullable<PartialCtxConfig["repo"]> = {};
  if (options.repo) repo.root = options.repo;
  if (options.maxFileBytes !== undefined) repo.maxFileBytes = options.maxFileBytes;
  const repoIgnore = [...options.exclude];
  if (repoIgnore.length > 0) repo.ignore = repoIgnore;
  if (Object.keys(repo).length > 0) {
    overrides.repo = repo;
  }

  if (options.noIndex) {
    overrides.index = { enabled: false };
  }

  const discovery: NonNullable<PartialCtxConfig["discovery"]> = {};
  if (options.discover) discovery.discover = options.discover;
  if (options.model) discovery.model = options.model;
  if (options.agentTimeout !== undefined) discovery.timeoutSeconds = options.agentTimeout;
  if (options.agentMaxTurns !== undefined) discovery.maxTurns = options.agentMaxTurns;
  if (Object.keys(discovery).length > 0) {
    overrides.discovery = discovery;
  }

  const git: NonNullable<PartialCtxConfig["git"]> = {};
  if (options.diff) git.diff = options.diff;
  const gitStatus = optionsBool(options.gitStatus);
  if (gitStatus !== undefined) git.gitStatus = gitStatus;
  if (options.gitMaxFiles !== undefined) git.maxFiles = options.gitMaxFiles;
  if (options.gitMaxPatchTokens !== undefined) {
    git.maxPatchTokens = options.gitMaxPatchTokens;
  }
  if (Object.keys(git).length > 0) {
    overrides.git = git;
  }

  const privacy: NonNullable<PartialCtxConfig["privacy"]> = {};
  if (options.privacy) privacy.mode = options.privacy;
  const redact = optionsBool(options.redact);
  if (redact !== undefined) privacy.redact = redact;
  if (options.neverInclude.length > 0) {
    privacy.neverInclude = [...options.neverInclude];
  }
  if (options.redactPattern.length > 0) {
    privacy.extraRedactPatterns = [...options.redactPattern];
  }
  if (Object.keys(privacy).length > 0) {
    overrides.privacy = privacy;
  }

  return overrides;
}

function emitConfigWarnings(
  warnings: readonly { filePath: string; keyPath?: string; message: string }[],
  runtime: CliRuntime,
  options: CliOptions,
): void {
  if (options.quiet || warnings.length === 0) {
    return;
  }

  const sorted = [...warnings].sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    return (left.keyPath ?? "").localeCompare(right.keyPath ?? "");
  });

  for (const warning of sorted) {
    const location = warning.keyPath
      ? `${warning.filePath}:${warning.keyPath}`
      : warning.filePath;
    runtime.stderr(`Warning: ${location}: ${warning.message}`);
  }
}

function toPipelineFileEntries(files: readonly DryRunScanFile[]): FileEntry[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size,
    mtime: file.mtime,
    hash: "",
    language: file.language,
    isText: true,
  }));
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function readFileOrEmpty(pathValue: string): string {
  try {
    return readFileSync(pathValue, "utf8");
  } catch {
    return "";
  }
}

function extractSliceText(content: string, startLine: number, endLine: number): string {
  if (content.length === 0) {
    return "";
  }
  const lines = normalizeLineEndings(content).split("\n");
  const startIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(startLine) - 1));
  const endIndex = Math.max(startIndex, Math.min(lines.length, Math.floor(endLine)));
  return lines.slice(startIndex, endIndex).join("\n");
}

function toTreeListing(
  paths: readonly string[],
  limit: number,
): string {
  if (paths.length === 0) {
    return "- none";
  }
  const ordered = [...paths].sort((left, right) => left.localeCompare(right));
  const lines = ordered.slice(0, limit).map((pathValue) => `- ${pathValue}`);
  const omitted = ordered.length - lines.length;
  if (omitted > 0) {
    lines.push(`- ... (${omitted} more paths)`);
  }
  return lines.join("\n");
}

function resolveTreeVerbosity(
  requestedTreeMode: CliOptions["tree"],
  defaultTreeMode: string,
  filesScanned: number,
): TreeVerbosity {
  const resolvedMode = requestedTreeMode ?? defaultTreeMode;
  if (resolvedMode === "none") {
    return "none";
  }
  if (resolvedMode === "selected") {
    return "selected";
  }
  if (resolvedMode === "full") {
    return "full";
  }
  return filesScanned <= 120 ? "full" : "selected";
}

function buildLanguageStats(files: readonly FileEntry[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function buildBuildHints(paths: readonly string[]): string[] {
  const set = new Set(paths);
  const hints: string[] = [];
  if (set.has("bun.lock") || set.has("package.json")) {
    hints.push("bun install");
  }
  if (set.has("tsconfig.json")) {
    hints.push("bun run build");
  }
  if (set.has("vitest.config.ts") || set.has("jest.config.ts")) {
    hints.push("bun test");
  }
  return hints.sort((left, right) => left.localeCompare(right));
}

function formatGitStatusSummary(
  status: ReturnType<typeof collectGitStatus>,
): string {
  if (!status) {
    return "- none";
  }

  const lines: string[] = [];
  lines.push(`branch: ${status.branch}`);
  if (status.upstream) {
    lines.push(
      `upstream: ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`,
    );
  }
  lines.push("changes: omitted");
  return lines.join("\n");
}

function formatGitDiffForPrompt(
  diff: ReturnType<typeof executeDiffMode>,
): string {
  if (!diff.ok) {
    return `- unavailable (${diff.failureKind ?? "git error"})`;
  }
  if (diff.files.length === 0) {
    return "- none";
  }

  const lines: string[] = [];
  for (const file of diff.files) {
    lines.push(`--- ${file.path} [${file.status}] ---`);
    if (file.hunks.length === 0) {
      lines.push("(no textual hunks)");
      continue;
    }
    for (const hunk of file.hunks) {
      lines.push(hunk.content);
    }
  }
  if (diff.capping?.applied && diff.capping.marker) {
    lines.push(diff.capping.marker);
  }
  return lines.join("\n");
}

function toSelectionEntry(entry: SelectionEntry): SelectionEntry {
  if (entry.mode === "slices") {
    return {
      path: entry.path,
      mode: "slices",
      priority: entry.priority,
      rationale: entry.rationale,
      slices: entry.slices.map((slice) => ({
        startLine: slice.startLine,
        endLine: slice.endLine,
        description: slice.description,
        rationale: slice.rationale,
      })),
    };
  }
  return {
    path: entry.path,
    mode: entry.mode,
    priority: entry.priority,
    rationale: entry.rationale,
  };
}

function toTokenReport(
  budget: number,
  report: {
    finalEstimate: number;
    bySection: Record<string, number>;
    byFile: Record<string, number>;
    degradations: Array<{
      action: string;
      targetPath?: string;
      fromMode?: string;
      toMode?: string;
      tokensSaved: number;
    }>;
  },
): TokenReport {
  return {
    budget,
    estimated: report.finalEstimate,
    bySection: report.bySection,
    byFile: report.byFile,
    degradations: report.degradations.map((degradation) => {
      const reason =
        degradation.targetPath && degradation.fromMode && degradation.toMode
          ? `degrade ${degradation.targetPath} ${degradation.fromMode}->${degradation.toMode}`
          : degradation.targetPath && degradation.action === "drop_codemap_only"
            ? `drop ${degradation.targetPath} codemap_only`
            : degradation.action;
      return {
        step: degradation.action,
        reason,
        delta: degradation.tokensSaved,
      };
    }),
  };
}

function estimateBudgetBreakdown(
  state: BudgetDegradationState,
  context: {
    taskText: string;
    gitDiffText: string;
    fileTextByPath: ReadonlyMap<string, string>;
    treeByVerbosity: Record<TreeVerbosity, string>;
  },
): BudgetEstimateBreakdown {
  const byFile: Record<string, number> = {};
  let filesTokens = 0;
  let codemapTokens = 0;

  const orderedEntries = [...state.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const entry of orderedEntries) {
    const content = context.fileTextByPath.get(entry.path) ?? "";
    let estimate = 0;
    if (entry.mode === "full") {
      estimate = estimateTokensFromText(content);
      filesTokens += estimate;
    } else if (entry.mode === "slices") {
      for (const slice of entry.slices) {
        estimate += estimateTokensFromText(
          extractSliceText(content, slice.startLine, slice.endLine),
        );
      }
      filesTokens += estimate;
    } else {
      const detail = state.codemapDetailByPath[entry.path] ?? "summary";
      estimate = detail === "complete"
        ? DEFAULT_CODEMAP_TOKENS_COMPLETE
        : DEFAULT_CODEMAP_TOKENS_SUMMARY;
      codemapTokens += estimate;
    }
    byFile[entry.path] = estimate;
  }

  const treeTokens = estimateTokensFromText(context.treeByVerbosity[state.treeVerbosity]);
  const bySection: Record<string, number> = {
    metadata: 120,
    task: estimateTokensFromText(context.taskText),
    repo_overview: 120,
    handoff_summary: 120,
    tree: treeTokens,
    files: filesTokens,
    codemaps: codemapTokens,
    git_diff: estimateTokensFromText(context.gitDiffText),
    manifest: 100,
  };

  return {
    bySection,
    byFile,
  };
}

function persistRunArtifactsSync(input: {
  repoRoot: string;
  runsDir: string;
  runId: string;
  runRecord: ReturnType<typeof createRunRecord>;
  promptText: string;
}): void {
  const runsRoot = resolve(input.repoRoot, input.runsDir);
  const runDir = resolve(runsRoot, input.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    resolve(runDir, "run.json"),
    `${JSON.stringify(input.runRecord, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(resolve(runDir, "prompt.md"), input.promptText, "utf8");

  const latestPath = resolve(runsRoot, "latest");
  const latestFallbackPath = resolve(runsRoot, "latest-run-id");
  const tempLatestPath = resolve(
    runsRoot,
    `.latest-${process.pid}-${Date.now().toString(36)}`,
  );
  try {
    symlinkSync(input.runId, tempLatestPath, "dir");
    renameSync(tempLatestPath, latestPath);
  } catch {
    // Fallback paths for environments that disallow replacing symlinks atomically.
    try {
      if (!existsSync(latestPath)) {
        symlinkSync(input.runId, latestPath, "dir");
      }
    } catch {
      // Ignore symlink update failures on restricted platforms.
    }
  }
  try {
    writeFileSync(latestFallbackPath, `${input.runId}\n`, "utf8");
  } catch {
    // Ignore fallback pointer update failures on restricted platforms.
  }
}

function runMainPipeline(input: {
  runId: string;
  taskText: string;
  command: ParsedMainCommand;
  runtime: CliRuntime;
  startedAtMs: number;
}): MainPipelineResult {
  const summary = buildMainSummaryDefaults(input.command.options);

  let repoRoot: string;
  try {
    repoRoot = detectRepoRoot({
      repoFlag: input.command.options.repo,
    });
  } catch (error) {
    const message =
      error instanceof RepoRootError
        ? error.message
        : `Failed to resolve repository root: ${
            error instanceof Error ? error.message : String(error)
          }`;
    return {
      ok: false,
      exitCode: error instanceof RepoRootError ? error.exitCode : 3,
      error: message,
      summary,
    };
  }

  const userConfig = parseUserConfigFile();
  const repoConfig = parseRepoConfigFile(repoRoot);
  const envConfig = parseEnvOverrides();
  emitConfigWarnings(userConfig.warnings, input.runtime, input.command.options);
  emitConfigWarnings(repoConfig.warnings, input.runtime, input.command.options);
  emitConfigWarnings(envConfig.warnings, input.runtime, input.command.options);

  const cliOverrides = buildCliConfigOverrides(input.command.options);
  let mergedConfig;
  try {
    mergedConfig = mergeConfigPrecedence({
      userConfig: userConfig.config,
      repoConfig: repoConfig.config,
      envConfig: envConfig.config,
      cliOverrides,
    });
  } catch (error) {
    return {
      ok: false,
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
      summary,
    };
  }

  const budget = input.command.options.budget ?? mergedConfig.defaults.budgetTokens;
  const reserve = input.command.options.reserve ?? mergedConfig.defaults.reserveTokens;
  const mode = input.command.options.mode ?? mergedConfig.defaults.mode;
  const format = input.command.options.format ?? mergedConfig.defaults.format;
  summary.mode = mode;
  summary.budget = budget;
  const phaseDurationsMs: Record<string, number> = {};

  const scanStartedAtMs = Date.now();
  const scan = scanFilesForDryRun(
    repoRoot,
    input.command.options.maxFileBytes ?? mergedConfig.repo.maxFileBytes,
    {
      skipBinary: mergedConfig.repo.skipBinary,
    },
  );
  phaseDurationsMs.scan = Math.max(0, Date.now() - scanStartedAtMs);
  const scannedFiles = toPipelineFileEntries(scan.files);
  summary.filesScanned = scannedFiles.length;

  if (scannedFiles.length === 0) {
    return {
      ok: false,
      exitCode: 3,
      error: "No readable repository files discovered after scanning.",
      summary,
    };
  }

  const reporter = new CliStderrReporter(input.command.options, input.runtime);
  if (scan.excludedBySize > 0) {
    reporter.warnOversizedFiles(scan.excludedBySize);
  }

  const indexPersistenceEnabled = mergedConfig.index.enabled;
  const indexDbPath =
    indexPersistenceEnabled && mergedConfig.index.engine === "sqlite"
      ? resolveIndexDatabasePath({
          repoRoot,
          cacheDir: input.command.options.cacheDir,
        })
      : ":memory:";
  const indexHandle = openSqliteIndex({
    dbPath: indexDbPath,
    rebuildOnSchemaChange: mergedConfig.index.rebuildOnSchemaChange,
    expectedSchemaVersion: INDEX_SCHEMA_VERSION,
  });

  let discoveryResult;
  try {
    const indexStartedAtMs = Date.now();
    applyIncrementalIndexUpdate(indexHandle.db, scannedFiles);
    phaseDurationsMs.index = Math.max(0, Date.now() - indexStartedAtMs);

    const discoveryStartedAtMs = Date.now();
    discoveryResult = runOfflineDiscovery({
      db: indexHandle.db,
      task: input.taskText,
      repoFiles: scannedFiles,
      readFileText: (pathValue) => readFileOrEmpty(resolve(repoRoot, pathValue)),
      reviewMode: mode === "review",
      maxFullFiles: mergedConfig.defaults.maxFullFiles,
      maxSliceFiles: Math.max(
        1,
        mergedConfig.defaults.maxFiles - mergedConfig.defaults.maxFullFiles,
      ),
      maxCodemapOnlyFiles: mergedConfig.defaults.maxFiles,
      maxFileBytes: mergedConfig.repo.maxFileBytes,
      maxSlicesPerFile: mergedConfig.defaults.maxSlicesPerFile,
    });
    phaseDurationsMs.discovery = Math.max(0, Date.now() - discoveryStartedAtMs);
  } finally {
    indexHandle.close();
  }

  const selectionManager = new SelectionManager(
    selectionManagerOptionsFromConfig(mergedConfig),
  );
  const fileByPath = new Map(scannedFiles.map((file) => [file.path, file] as const));
  for (const entry of discoveryResult.selection) {
    const file = fileByPath.get(entry.path);
    selectionManager.add(entry, {
      fileBytes: file?.size,
      isBinary: false,
    });
  }

  if (selectionManager.getAll().length === 0) {
    const fallback = scannedFiles[0];
    if (!fallback) {
      return {
        ok: false,
        exitCode: 3,
        error: "No readable repository files discovered after scanning.",
        summary,
      };
    }
    selectionManager.add({
      path: fallback.path,
      mode: "full",
      priority: "core",
      rationale: "fallback selection: first scanned file",
    });
  }

  const gitStatusEnabled =
    optionsBool(input.command.options.gitStatus) ?? mergedConfig.git.gitStatus;
  const gitStatus = gitStatusEnabled ? collectGitStatus({ cwd: repoRoot }) : null;
  const gitChangedPaths = gitStatus?.changes.map((change) => change.path) ?? [];

  selectionManager.finalizePriorityScores({
    explicitIncludePaths: input.command.options.include,
    explicitEntrypointPaths: input.command.options.entrypoint,
    taskText: input.taskText,
    reviewMode: mode === "review",
    gitChangedPaths,
  });
  const constrained = selectionManager.enforceHardConstraints();
  if (constrained.entries.length === 0) {
    return {
      ok: false,
      exitCode: 3,
      error: "Selection constraints removed all candidate files.",
      summary,
    };
  }

  const allPaths = scannedFiles.map((file) => file.path);
  const selectedPaths = constrained.entries.map((entry) => entry.path);
  const treeByVerbosity: Record<TreeVerbosity, string> = {
    none: "- none",
    selected: toTreeListing(selectedPaths, TREE_SELECTED_LIMIT),
    full: toTreeListing(allPaths, TREE_FULL_LIMIT),
  };
  const initialTreeVerbosity = resolveTreeVerbosity(
    input.command.options.tree,
    mergedConfig.defaults.treeMode,
    scannedFiles.length,
  );

  const diffMode = input.command.options.diff ?? mergedConfig.git.diff;
  const gitDiffResult = executeDiffMode({
    cwd: repoRoot,
    mode: diffMode,
    maxFiles: input.command.options.gitMaxFiles ?? mergedConfig.git.maxFiles,
    maxPatchTokens:
      input.command.options.gitMaxPatchTokens ?? mergedConfig.git.maxPatchTokens,
    selectedPaths,
    taskTerms: extractTaskTerms(input.taskText).searchTerms,
  });
  const gitDiffText = formatGitDiffForPrompt(gitDiffResult);

  const fileTextByPath = new Map<string, string>();
  const readFileText = (pathValue: string): string => {
    const cached = fileTextByPath.get(pathValue);
    if (cached !== undefined) {
      return cached;
    }
    const text = readFileOrEmpty(resolve(repoRoot, pathValue));
    fileTextByPath.set(pathValue, text);
    return text;
  };
  for (const pathValue of selectedPaths) {
    readFileText(pathValue);
  }

  const codemapDetailByPath: Record<string, CodemapDetail> = {};
  for (const entry of constrained.entries) {
    if (entry.mode !== "codemap_only") {
      continue;
    }
    codemapDetailByPath[entry.path] =
      mergedConfig.defaults.codemaps === "complete" ? "complete" : "summary";
  }

  const budgetStartedAtMs = Date.now();
  const normalizedBudget = runBudgetNormalizationLoop({
    budgetTokens: budget,
    reserveTokens: reserve,
    entries: constrained.entries,
    codemapDetailByPath,
    treeVerbosity: initialTreeVerbosity,
    failOnOverbudget: input.command.options.failOnOverbudget,
    estimateBreakdown: (state) =>
      estimateBudgetBreakdown(state, {
        taskText: input.taskText,
        gitDiffText,
        fileTextByPath,
        treeByVerbosity,
      }),
  });
  phaseDurationsMs.budget = Math.max(0, Date.now() - budgetStartedAtMs);

  const tokenReport = toTokenReport(budget, normalizedBudget.report);
  summary.estimatedTokens = tokenReport.estimated;
  summary.degradationsApplied = tokenReport.degradations.length;

  if (normalizedBudget.report.degradations.length > 0) {
    reporter.warnBudgetDegradations(normalizedBudget.report.degradations.length);
  }
  if (normalizedBudget.report.shouldFail) {
    return {
      ok: false,
      exitCode: 3,
      error:
        normalizedBudget.report.warning ??
        `Estimated prompt tokens ${normalizedBudget.report.finalEstimate} exceed budget ${budget}`,
      summary,
    };
  }

  const finalEntries = normalizedBudget.state.entries;
  summary.filesSelected = finalEntries.length;
  summary.discoveryBackend = "offline";
  const assembleStartedAtMs = Date.now();

  const filesSection: FilesSectionEntry[] = finalEntries.map((entry) => {
    if (entry.mode === "full") {
      return {
        path: entry.path,
        mode: "full",
        priority: entry.priority,
        rationale: entry.rationale,
        content: readFileText(entry.path),
      };
    }
    if (entry.mode === "slices") {
      const content = readFileText(entry.path);
      return {
        path: entry.path,
        mode: "slices",
        priority: entry.priority,
        rationale: entry.rationale,
        slices: entry.slices.map((slice) => ({
          startLine: slice.startLine,
          endLine: slice.endLine,
          description: slice.description,
          rationale: slice.rationale,
          content: extractSliceText(content, slice.startLine, slice.endLine),
        })),
      };
    }
    return {
      path: entry.path,
      mode: "codemap_only",
      priority: entry.priority,
      rationale: entry.rationale,
    };
  });

  const codemaps = finalEntries
    .filter((entry) => entry.mode === "codemap_only")
    .map((entry) => {
      const content = readFileText(entry.path);
      return {
        path: entry.path,
        language:
          fileByPath.get(entry.path)?.language ?? detectPipelineLanguage(entry.path),
        lines: countLines(content),
        symbols: [],
      };
    });

  const promptRunId = input.runId;
  const metadata: MetadataField[] = [
    { key: "repo_root", value: repoRoot },
    { key: "run_id", value: promptRunId },
    { key: "mode", value: mode },
    { key: "format", value: format },
    { key: "privacy_mode", value: mergedConfig.privacy.mode },
    { key: "discovery_backend", value: "offline" },
  ];

  const repoOverview: RepoOverviewSectionInput = {
    buildHints: buildBuildHints(allPaths),
    languageStats: buildLanguageStats(scannedFiles),
    gitStatusSummary: formatGitStatusSummary(gitStatus),
    indexStatus: indexPersistenceEnabled
      ? `indexed_files=${scannedFiles.length}, persistence=enabled`
      : "indexed_files=0, persistence=disabled (--no-index or config)",
    ignoreSummary: {
      gitignorePatterns: 0,
      configIgnores: mergedConfig.repo.ignore.length,
    },
  };

  const sections = renderPromptSections({
    metadata,
    task: input.taskText,
    openQuestions: discoveryResult.openQuestions,
    repoOverview,
    tree: treeByVerbosity[normalizedBudget.state.treeVerbosity],
    handoffSummary: discoveryResult.handoffSummary,
    codemaps,
    files: filesSection,
    gitDiff: gitDiffText,
    tokenReport,
    manifest: finalEntries,
    lineNumbers:
      optionsBool(input.command.options.lineNumbers) ?? mergedConfig.defaults.lineNumbers,
  });
  const sectionByKey = new Map(sections.map((section) => [section.key, section.body] as const));

  const template = getTemplateByName(mode, repoRoot);
  if (!template) {
    return {
      ok: false,
      exitCode: 3,
      error: `Template not found for mode '${mode}'`,
      summary,
    };
  }

  const renderedTemplate = renderTemplate(template.body, {
    REPO_ROOT: repoRoot,
    RUN_ID: promptRunId,
    BUDGET_TOKENS: String(budget),
    PROMPT_TOKENS_ESTIMATE: String(tokenReport.estimated),
    LINE_NUMBERS: String(
      optionsBool(input.command.options.lineNumbers) ?? mergedConfig.defaults.lineNumbers,
    ),
    PRIVACY_MODE: mergedConfig.privacy.mode,
    DISCOVERY_BACKEND: "offline",
    DIFF_MODE: diffMode,
    TASK: sectionByKey.get("task") ?? "",
    OPEN_QUESTIONS: sectionByKey.get("open_questions") ?? "",
    REPO_OVERVIEW: sectionByKey.get("repo_overview") ?? "",
    TREE: sectionByKey.get("tree") ?? "",
    HANDOFF_SUMMARY: sectionByKey.get("handoff_summary") ?? "",
    CODEMAPS: sectionByKey.get("codemaps") ?? "",
    FILES: sectionByKey.get("files") ?? "",
    GIT_DIFF: sectionByKey.get("git_diff") ?? "",
    TOKEN_REPORT: sectionByKey.get("token_report") ?? "",
    MANIFEST: sectionByKey.get("manifest") ?? "",
  });
  for (const warning of renderedTemplate.warnings) {
    if (!input.command.options.quiet) {
      input.runtime.stderr(`Warning: ${warning}`);
    }
  }

  const promptText =
    format === "markdown+xmltags"
      ? renderedTemplate.output
      : formatPromptOutput(format, sections);
  const redaction = applyPromptRedaction(promptText, mergedConfig.privacy);
  if (!input.command.options.quiet && redaction.invalidPatterns.length > 0) {
    input.runtime.stderr(
      `Warning: ignored ${redaction.invalidPatterns.length} invalid redact pattern(s).`,
    );
  }
  if (redaction.redactionCount > 0) {
    reporter.warnRedactedSecrets(redaction.redactionCount);
  }
  const finalPromptText = redaction.text;
  phaseDurationsMs.assemble = Math.max(0, Date.now() - assembleStartedAtMs);

  const runRecord = createRunRecord({
    runId: input.runId,
    task: input.taskText,
    config: mergedConfig,
    discovery: discoveryResult,
    selection: finalEntries.map((entry) => toSelectionEntry(entry)),
    tokenReport,
    timing: {
      startedAt: new Date(input.startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - input.startedAtMs),
      phaseDurationsMs: {
        scan: phaseDurationsMs.scan ?? 0,
        index: phaseDurationsMs.index ?? 0,
        discovery: phaseDurationsMs.discovery ?? 0,
        budget: phaseDurationsMs.budget ?? 0,
        assemble: phaseDurationsMs.assemble ?? 0,
      },
    },
  });
  if (mergedConfig.output.storeRuns) {
    persistRunArtifactsSync({
      repoRoot,
      runsDir: mergedConfig.output.runsDir,
      runId: input.runId,
      runRecord,
      promptText: finalPromptText,
    });
  }

  return {
    ok: true,
    promptText: finalPromptText,
    summary,
  };
}

interface ResolvedTaskText {
  taskText: string;
}

function resolveTaskText(
  command: ParsedMainCommand,
  runtime: CliRuntime,
): { ok: true; value: ResolvedTaskText } | { ok: false; exitCode: number } {
  const positionalTask = command.taskText?.trim();
  if (positionalTask && positionalTask.length > 0) {
    return {
      ok: true,
      value: {
        taskText: positionalTask,
      },
    };
  }

  if (!runtime.isStdinTty()) {
    const stdinRaw = runtime.readStdin();
    if (stdinRaw.length > 10_000 && !command.options.quiet) {
      runtime.stderr(
        "Warning: stdin task text exceeds 10KB; verify you did not pipe a full source file.",
      );
    }
    const stdinTask = stdinRaw.trim();
    if (stdinTask.length > 0) {
      return {
        ok: true,
        value: {
          taskText: stdinTask,
        },
      };
    }
  }

  const taskFilePath = command.options.taskFile?.trim();
  if (taskFilePath && taskFilePath.length > 0) {
    try {
      const taskFromFile = runtime.readFile(taskFilePath).trim();
      if (taskFromFile.length > 0) {
        return {
          ok: true,
          value: {
            taskText: taskFromFile,
          },
        };
      }
    } catch (error) {
      runtime.stderr(
        `Failed to read task file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ok: false, exitCode: 2 };
    }
  }

  runtime.stderr(
    "No task provided. Pass positional task text, pipe stdin, or use --task-file.",
  );
  return { ok: false, exitCode: 2 };
}

function emitMainCommandProgress(options: CliOptions, runtime: CliRuntime): void {
  const reporter = new CliStderrReporter(options, runtime);

  reporter.scanningRepository(options.verbose ? 0 : undefined);
  reporter.updatingIndex(options.verbose ? 0 : undefined);
  reporter.discoveryBackend(options, options.verbose ? 0 : undefined);
  reporter.discoveryTurn(1, options.agentMaxTurns ?? 1, options.verbose ? 0 : undefined);

  const discoverMode = options.discover ?? "auto";
  const hasApiKey =
    Boolean(process.env.OPENAI_API_KEY?.trim()) ||
    Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
    Boolean(process.env.GOOGLE_API_KEY?.trim());
  if (discoverMode === "llm" && !options.noLlm && !hasApiKey) {
    reporter.warnNoApiKeyFallback();
  }

  reporter.assemblingPrompt(options.verbose ? 0 : undefined);
  reporter.tokenSummary({
    budget: options.budget ?? 60_000,
    estimated: 0,
    fullFiles: 0,
    sliceFiles: 0,
    codemapFiles: 0,
  });
}

function resolveDiscoveryBackendLabel(options: CliOptions): string {
  if (options.dryRun) {
    return "offline";
  }
  const discoverMode = options.discover ?? "auto";
  if (options.noLlm || discoverMode === "offline") {
    return "offline";
  }
  if (discoverMode === "local-cli") {
    return "local-cli";
  }
  if (discoverMode === "llm") {
    return "llm";
  }
  return "auto";
}

function emitMainCommandJsonSummary(input: {
  runId: string;
  options: CliOptions;
  runtime: CliRuntime;
  startedAtMs: number;
  summary?: MainPipelineSummary;
  exitCode: number;
}): void {
  if (!input.options.jsonSummary) {
    return;
  }

  const summary = input.summary ?? buildMainSummaryDefaults(input.options);

  const payload = {
    run_id: input.runId,
    mode: summary.mode,
    discovery_backend: summary.discoveryBackend,
    files_scanned: summary.filesScanned,
    files_selected: summary.filesSelected,
    budget: summary.budget,
    estimated_tokens: summary.estimatedTokens,
    degradations_applied: summary.degradationsApplied,
    duration_ms: Math.max(0, Math.floor(Date.now() - input.startedAtMs)),
    exit_code: input.exitCode,
  };
  input.runtime.stderr(JSON.stringify(payload));
}

export const DEFAULT_RUNTIME: CliRuntime = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  isStdinTty: () => Boolean(process.stdin.isTTY),
  readStdin: () => readFileSync(0, "utf8"),
  readFile: (path) => readFileSync(path, "utf8"),
  readLink: (path) => readlinkSync(path),
  writeFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  copyToClipboard: (contents) => defaultCopyToClipboard(contents),
  openInPager: (absolutePath, pagerCommand) =>
    defaultOpenInPager(absolutePath, pagerCommand),
};

export function handleMainCommand(
  command: ParsedMainCommand,
  runtime: CliRuntime,
): number {
  const startedAtMs = Date.now();
  const runId = generateRunId(
    resolve(command.options.repo ?? process.cwd()),
    new Date(startedAtMs),
  );
  let summary = buildMainSummaryDefaults(command.options);

  const finish = (exitCode: number): number => {
    emitMainCommandJsonSummary({
      runId,
      options: command.options,
      runtime,
      startedAtMs,
      summary,
      exitCode,
    });
    return exitCode;
  };

  const emitDryRunOutput = (taskText: string): number => {
    const repoRoot = resolve(command.options.repo ?? process.cwd());
    const scan = scanFilesForDryRun(
      repoRoot,
      command.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    );
    const dryRunPlan = formatDryRunPlan({
      task: taskText,
      options: command.options,
      repoRoot,
      scan,
    });
    summary = {
      ...summary,
      discoveryBackend: "offline",
      filesScanned: scan.files.length,
      budget: command.options.budget ?? DEFAULT_BUDGET_TOKENS,
      estimatedTokens: Math.ceil(
        scan.files.reduce((sum, file) => sum + file.size, 0) / ESTIMATED_CHARS_PER_TOKEN,
      ),
      filesSelected: 0,
      degradationsApplied: 0,
    };
    return finish(routePromptOutput(dryRunPlan, command.options, runtime));
  };
  const resolvedTask = resolveTaskText(command, runtime);
  if (!resolvedTask.ok) {
    return finish(resolvedTask.exitCode);
  }

  if (command.options.dryRun) {
    return emitDryRunOutput(resolvedTask.value.taskText);
  }

  emitMainCommandProgress(command.options, runtime);
  const pipeline = runMainPipeline({
    runId,
    taskText: resolvedTask.value.taskText,
    command,
    runtime,
    startedAtMs,
  });
  summary = pipeline.summary;

  if (!pipeline.ok) {
    runtime.stderr(pipeline.error);
    return finish(pipeline.exitCode);
  }

  return finish(routePromptOutput(pipeline.promptText, command.options, runtime));
}

export function handleInitCommand(
  command: ParsedInitCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  const ctxRoot = resolve(repoRoot, ".ctx");
  const templatesDir = resolve(ctxRoot, "templates");
  const runsDir = resolve(ctxRoot, "runs");
  const configPath = resolve(ctxRoot, "config.toml");
  const gitignorePath = resolve(repoRoot, ".gitignore");

  try {
    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
  } catch (error) {
    runtime.stderr(
      `Failed to initialize .ctx directories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }

  let createdConfig = false;
  try {
    if (!existsSync(configPath)) {
      writeFileSync(configPath, INIT_CONFIG_TEMPLATE, "utf8");
      createdConfig = true;
    }
  } catch (error) {
    runtime.stderr(
      `Failed to write .ctx/config.toml: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }

  let gitignoreUpdated = false;
  const hasGitignore = existsSync(gitignorePath);
  if (hasGitignore) {
    try {
      const currentGitignore = readFileSync(gitignorePath, "utf8");
      const hasRunsEntry = currentGitignore
        .replace(/\r\n/g, "\n")
        .split("\n")
        .some((line) => {
          const normalized = line.trim();
          return normalized === ".ctx/runs/" || normalized === ".ctx/runs";
        });

      if (!hasRunsEntry) {
        const separator =
          currentGitignore.length > 0 && !currentGitignore.endsWith("\n") ? "\n" : "";
        writeFileSync(
          gitignorePath,
          `${currentGitignore}${separator}.ctx/runs/\n`,
          "utf8",
        );
        gitignoreUpdated = true;
      }
    } catch (error) {
      runtime.stderr(
        `Failed to update .gitignore: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 3;
    }
  }

  runtime.stdout(
    [
      `Initialized ctx workspace at ${repoRoot}`,
      "- ensured .ctx/templates/",
      "- ensured .ctx/runs/",
      createdConfig ? "- created .ctx/config.toml" : "- kept existing .ctx/config.toml",
      hasGitignore
        ? gitignoreUpdated
          ? "- updated .gitignore with .ctx/runs/"
          : "- kept existing .gitignore entry for .ctx/runs/"
        : "- .gitignore not found; skipped ignore update",
      "Next steps:",
      "1) Review .ctx/config.toml",
      "2) Run `ctx templates list`",
      "3) Run `ctx \"your task\"`",
    ].join("\n"),
  );
  return 0;
}

export function handleAgentsCommand(
  _command: ParsedAgentsCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout("agents handler pending");
  return 0;
}

export function handleIndexCommand(
  command: ParsedIndexCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  const dbPath = resolveIndexDatabasePath({
    repoRoot,
    cacheDir: command.options.cacheDir,
  });

  const formatStatus = (input: {
    schemaVersion: string | null;
    indexedFiles: number;
    lastIndexedAt: string | null;
    dbSizeBytes: number;
  }): string =>
    [
      `Index path: ${dbPath}`,
      `Schema version: ${input.schemaVersion ?? "none"}`,
      `Indexed files: ${input.indexedFiles}`,
      `Last updated: ${input.lastIndexedAt ?? "never"}`,
      `Database size: ${input.dbSizeBytes} bytes`,
    ].join("\n");

  const readStatus = (): {
    schemaVersion: string | null;
    indexedFiles: number;
    lastIndexedAt: string | null;
    dbSizeBytes: number;
  } => {
    if (!existsSync(dbPath)) {
      return {
        schemaVersion: null,
        indexedFiles: 0,
        lastIndexedAt: null,
        dbSizeBytes: 0,
      };
    }

    const handle = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
      expectedSchemaVersion: INDEX_SCHEMA_VERSION,
    });
    try {
      const schemaRow = handle.db
        .query<{ value: string }>(
          `SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1;`,
        )
        .get();
      const fileStatsRow = handle.db
        .query<{ count: number; last_indexed_at: string | null }>(
          `SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed_at FROM files;`,
        )
        .get();
      const dbSizeBytes = statSync(dbPath).size;
      return {
        schemaVersion: schemaRow?.value ?? null,
        indexedFiles: fileStatsRow?.count ?? 0,
        lastIndexedAt: fileStatsRow?.last_indexed_at ?? null,
        dbSizeBytes,
      };
    } finally {
      handle.close();
    }
  };

  if (!command.options.rebuild) {
    try {
      runtime.stdout(formatStatus(readStatus()));
      return 0;
    } catch (error) {
      runtime.stderr(
        `Failed to read index status: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 3;
    }
  }

  try {
    const handle = openSqliteIndex({
      dbPath,
      rebuildOnSchemaChange: true,
      expectedSchemaVersion: INDEX_SCHEMA_VERSION,
    });
    try {
      runtime.stderr("Rebuilding index...");
      handle.db.exec(
        [
          "DROP TABLE IF EXISTS imports;",
          "DROP TABLE IF EXISTS symbols;",
          "DROP TABLE IF EXISTS files;",
          "DROP TABLE IF EXISTS schema_meta;",
        ].join("\n"),
      );
      initializeIndexSchema(handle.db, {
        rebuildOnSchemaChange: true,
        expectedVersion: INDEX_SCHEMA_VERSION,
      });
      runtime.stderr("Indexing file 0/0...");
      runtime.stdout(`Index rebuilt: ${dbPath} (indexed 0 files)`);
    } finally {
      handle.close();
    }
    return 0;
  } catch (error) {
    runtime.stderr(
      `Failed to rebuild index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 3;
  }
}

export function handleTemplatesCommand(
  command: ParsedTemplatesCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  try {
    if (command.action === "list") {
      const templates = listAvailableTemplates(repoRoot);
      runtime.stdout(formatTemplatesListOutput(templates, repoRoot));
      return 0;
    }

    const templateName = command.name ?? "";
    const template = getTemplateByName(templateName, repoRoot);
    if (!template) {
      runtime.stderr(`Template not found: ${templateName}`);
      return 3;
    }

    runtime.stdout(template.body);
    return 0;
  } catch (error) {
    runtime.stderr(
      `Failed to load templates: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }
}

export function handleExplainCommand(
  command: ParsedExplainCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  try {
    const loadedRun = loadRunRecordForExplain({
      repoRoot,
      runsDir: ".ctx/runs",
      target: command.target,
      io: {
        readFile: runtime.readFile,
        readLink: runtime.readLink,
      },
    });
    runtime.stdout(formatExplainReport(loadedRun));
    return 0;
  } catch (error) {
    runtime.stderr(
      `Failed to load explain report for '${command.target}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }
}

export function handleManifestCommand(
  command: ParsedManifestCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  try {
    const loadedRun = loadRunRecordForManifest({
      repoRoot,
      runsDir: ".ctx/runs",
      target: command.target,
      io: {
        readFile: runtime.readFile,
        readLink: runtime.readLink,
      },
    });
    const report = buildManifestReport(loadedRun, repoRoot);
    const rendered = formatManifestReport(report);
    return routePromptOutput(rendered, command.options, runtime);
  } catch (error) {
    runtime.stderr(
      `Failed to load manifest for '${command.target}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }
}

export function handleOpenCommand(
  command: ParsedOpenCommand,
  runtime: CliRuntime,
): number {
  const repoRoot = resolve(command.options.repo ?? process.cwd());
  let runId: string;
  try {
    const loadedRun = loadRunRecordForExplain({
      repoRoot,
      runsDir: ".ctx/runs",
      target: command.target,
      io: {
        readFile: runtime.readFile,
        readLink: runtime.readLink,
      },
    });
    runId = loadedRun.runId;
  } catch (error) {
    runtime.stderr(
      `Failed to resolve run '${command.target}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 3;
  }

  const promptPath = resolve(repoRoot, ".ctx/runs", runId, "prompt.md");
  try {
    runtime.readFile(promptPath);
  } catch {
    runtime.stderr(
      `Prompt artifact not found for run '${runId}' at ${promptPath}. Enable config.output.store_runs to save prompts for later viewing.`,
    );
    return 3;
  }

  const pagerCommand = process.env.PAGER?.trim() || "less";
  const opened = runtime.openInPager(promptPath, pagerCommand);
  if (!opened.ok) {
    runtime.stderr(`Failed to open prompt in pager '${pagerCommand}': ${opened.error}`);
    return 3;
  }
  return 0;
}

export function routeCommand(command: ParsedCommand, runtime: CliRuntime): number {
  switch (command.kind) {
    case "main":
      return handleMainCommand(command, runtime);
    case "init":
      return handleInitCommand(command, runtime);
    case "agents":
      return handleAgentsCommand(command, runtime);
    case "index":
      return handleIndexCommand(command, runtime);
    case "templates":
      return handleTemplatesCommand(command, runtime);
    case "explain":
      return handleExplainCommand(command, runtime);
    case "manifest":
      return handleManifestCommand(command, runtime);
    case "open":
      return handleOpenCommand(command, runtime);
    default: {
      const neverValue: never = command;
      runtime.stderr(`Unknown command kind: ${String(neverValue)}`);
      return 2;
    }
  }
}
