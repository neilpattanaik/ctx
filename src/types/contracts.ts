export type CtxMode = "plan" | "question" | "review" | "context";

export type OutputFormat = "markdown" | "markdown+xmltags" | "xml" | "plain";
export type TreeMode = "auto" | "full" | "selected" | "none";
export type CodemapMode = "auto" | "selected" | "none" | "complete";
export type DiscoverMode = "auto" | "llm" | "local-cli" | "offline";
export type DiscoveryProvider = "openai" | "anthropic" | "google";
export type CacheMode = "repo" | "global" | "off";
export type PrivacyMode = "normal" | "strict" | "airgap";
export type PathDisplayMode = "relative" | "absolute";

export interface DefaultsConfig {
  mode: CtxMode;
  format: OutputFormat;
  budgetTokens: number;
  reserveTokens: number;
  treeMode: TreeMode;
  codemaps: CodemapMode;
  maxFiles: number;
  maxFullFiles: number;
  maxSlicesPerFile: number;
  lineNumbers: boolean;
}

export interface RepoConfig {
  root: string;
  useGitignore: boolean;
  ignore: string[];
  maxFileBytes: number;
  skipBinary: boolean;
}

export type IndexEngine = "sqlite" | "memory";

export interface IndexConfig {
  enabled: boolean;
  engine: IndexEngine;
  rebuildOnSchemaChange: boolean;
}

export interface DiscoveryConfig {
  discover: DiscoverMode;
  provider: DiscoveryProvider;
  model: string;
  timeoutSeconds: number;
  maxTurns: number;
}

export interface LocalCliConfig {
  agentPriority: string[];
  codexCliCommand: string;
  claudeCliCommand: string;
  geminiCliCommand: string;
}

export type DiffMode =
  | "off"
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "main"
  | `compare:${string}`
  | `back:${number}`
  | string;

export interface GitConfig {
  diff: DiffMode;
  gitStatus: boolean;
  maxFiles: number;
  maxPatchTokens: number;
}

export interface PrivacyConfig {
  mode: PrivacyMode;
  redact: boolean;
  neverInclude: string[];
  extraRedactPatterns: string[];
}

export interface OutputConfig {
  includeManifestFooter: boolean;
  includeTokenReport: boolean;
  pathDisplay: PathDisplayMode;
  storeRuns: boolean;
  runsDir: string;
}

export interface CtxConfig {
  defaults: DefaultsConfig;
  repo: RepoConfig;
  index: IndexConfig;
  discovery: DiscoveryConfig;
  localCli: LocalCliConfig;
  git: GitConfig;
  privacy: PrivacyConfig;
  output: OutputConfig;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  hash: string;
  language: string;
  isText: boolean;
}

export type SelectionMode = "full" | "slices" | "codemap_only";
export type SelectionPriority = "core" | "support" | "ref";

export interface SliceRange {
  startLine: number;
  endLine: number;
  description: string;
  rationale: string;
}

interface BaseSelectionEntry {
  path: string;
  mode: SelectionMode;
  priority: SelectionPriority;
  rationale: string;
}

export interface FullSelectionEntry extends BaseSelectionEntry {
  mode: "full";
  slices?: never;
}

export interface SlicedSelectionEntry extends BaseSelectionEntry {
  mode: "slices";
  slices: SliceRange[];
}

export interface CodemapOnlySelectionEntry extends BaseSelectionEntry {
  mode: "codemap_only";
  slices?: never;
}

export type SelectionEntry =
  | FullSelectionEntry
  | SlicedSelectionEntry
  | CodemapOnlySelectionEntry;

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method"
  | "module"
  | "unknown";

export interface SymbolInfo {
  kind: SymbolKind;
  signature: string;
  line: number;
}

export interface CodemapEntry {
  path: string;
  language: string;
  lines: number;
  symbols: SymbolInfo[];
}

export interface OpenQuestion {
  question: string;
  whyItMatters: string;
  defaultAssumption: string;
}

export interface PathNote {
  path: string;
  notes: string;
}

export interface DataFlowNote {
  name: string;
  notes: string;
}

export interface ConfigKnobNote {
  key: string;
  where: string;
  notes: string;
}

export interface DiscoveryHandoffSummary {
  entrypoints: PathNote[];
  keyModules: PathNote[];
  dataFlows: DataFlowNote[];
  configKnobs: ConfigKnobNote[];
  tests: PathNote[];
}

export interface DiscoveryResult {
  openQuestions: OpenQuestion[];
  handoffSummary: DiscoveryHandoffSummary;
  selection: SelectionEntry[];
}

export interface ToolCall<TArgs = Record<string, unknown>> {
  id: string;
  tool: string;
  args: TArgs;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolResultMeta {
  truncated?: boolean;
  tokensEstimate?: number;
  [key: string]: unknown;
}

export interface ToolResultOk<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
  meta?: ToolResultMeta;
}

export interface ToolResultErr {
  id: string;
  ok: false;
  error: ToolError;
  meta?: ToolResultMeta;
}

export type ToolResult<TResult = unknown> =
  | ToolResultOk<TResult>
  | ToolResultErr;

export interface TokenDegradation {
  step: string;
  reason: string;
  delta: number;
}

export interface TokenReport {
  budget: number;
  estimated: number;
  bySection: Record<string, number>;
  byFile: Record<string, number>;
  degradations: TokenDegradation[];
}

export interface RunTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  phaseDurationsMs: Record<string, number>;
}

export interface RunRecord {
  runId: string;
  task: string;
  config: CtxConfig;
  discovery: DiscoveryResult;
  selection: SelectionEntry[];
  tokenReport: TokenReport;
  timing: RunTiming;
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`${fieldName} must not be empty`);
  }
}

export function createSliceRange(range: SliceRange): SliceRange {
  assertPositiveInteger(range.startLine, "SliceRange.startLine");
  assertPositiveInteger(range.endLine, "SliceRange.endLine");
  if (range.endLine < range.startLine) {
    throw new Error(
      "SliceRange.endLine must be greater than or equal to startLine",
    );
  }
  assertNonEmpty(range.description, "SliceRange.description");
  assertNonEmpty(range.rationale, "SliceRange.rationale");
  return { ...range };
}

export function createSelectionEntry(entry: SelectionEntry): SelectionEntry {
  assertNonEmpty(entry.path, "SelectionEntry.path");
  assertNonEmpty(entry.rationale, "SelectionEntry.rationale");

  if (entry.mode === "slices") {
    if (entry.slices.length < 1) {
      throw new Error("SelectionEntry(slices) must include at least one slice");
    }
    return {
      ...entry,
      slices: entry.slices.map((slice) => createSliceRange(slice)),
    };
  }

  return { ...entry };
}

export function createToolCall<TArgs = Record<string, unknown>>(
  id: string,
  tool: string,
  args: TArgs,
): ToolCall<TArgs> {
  assertNonEmpty(id, "ToolCall.id");
  assertNonEmpty(tool, "ToolCall.tool");
  return { id, tool, args };
}

export function createToolResultOk<TResult = unknown>(
  id: string,
  result: TResult,
  meta?: ToolResultMeta,
): ToolResultOk<TResult> {
  assertNonEmpty(id, "ToolResultOk.id");
  return { id, ok: true, result, meta };
}

export function createToolResultErr(
  id: string,
  error: ToolError,
  meta?: ToolResultMeta,
): ToolResultErr {
  assertNonEmpty(id, "ToolResultErr.id");
  assertNonEmpty(error.code, "ToolError.code");
  assertNonEmpty(error.message, "ToolError.message");
  return { id, ok: false, error: { ...error }, meta };
}

export function createRunRecord(record: RunRecord): RunRecord {
  assertNonEmpty(record.runId, "RunRecord.runId");
  assertNonEmpty(record.task, "RunRecord.task");
  if (record.tokenReport.budget < 0 || record.tokenReport.estimated < 0) {
    throw new Error("RunRecord token report values must be non-negative");
  }
  if (record.timing.durationMs < 0) {
    throw new Error("RunRecord timing duration must be non-negative");
  }
  return { ...record };
}
