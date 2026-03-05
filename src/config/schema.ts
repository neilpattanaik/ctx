import type {
  CtxConfig,
  DefaultsConfig,
  DiscoveryConfig,
  GitConfig,
  IndexConfig,
  LocalCliConfig,
  OutputConfig,
  PrivacyConfig,
  RepoConfig,
} from "../types";

export const DEFAULT_REPO_IGNORE: readonly string[] = [
  "**/dist/**",
  "**/.venv/**",
  "**/node_modules/**",
  "**/.git/**",
];

export const DEFAULT_NEVER_INCLUDE: readonly string[] = [
  "**/.env",
  "**/*secret*",
  "**/*private_key*",
];

export const DEFAULT_AGENT_PRIORITY: readonly string[] = [
  "codex-cli",
  "claude-cli",
  "gemini-cli",
];

export const DEFAULTS_CONFIG: DefaultsConfig = {
  mode: "plan",
  format: "markdown+xmltags",
  budgetTokens: 60_000,
  reserveTokens: 15_000,
  treeMode: "auto",
  codemaps: "auto",
  maxFiles: 80,
  maxFullFiles: 10,
  maxSlicesPerFile: 4,
  lineNumbers: true,
};

export const REPO_CONFIG_DEFAULTS: RepoConfig = {
  root: ".",
  useGitignore: true,
  ignore: [...DEFAULT_REPO_IGNORE],
  maxFileBytes: 1_500_000,
  skipBinary: true,
};

export const INDEX_CONFIG_DEFAULTS: IndexConfig = {
  enabled: true,
  engine: "sqlite",
  rebuildOnSchemaChange: true,
};

export const DISCOVERY_CONFIG_DEFAULTS: DiscoveryConfig = {
  discover: "auto",
  provider: "openai",
  model: "",
  timeoutSeconds: 600,
  maxTurns: 20,
};

export const LOCAL_CLI_CONFIG_DEFAULTS: LocalCliConfig = {
  agentPriority: [...DEFAULT_AGENT_PRIORITY],
  codexCliCommand: "codex",
  claudeCliCommand: "claude",
  geminiCliCommand: "gemini",
};

export const GIT_CONFIG_DEFAULTS: GitConfig = {
  diff: "off",
  gitStatus: true,
  maxFiles: 20,
  maxPatchTokens: 6000,
};

export const PRIVACY_CONFIG_DEFAULTS: PrivacyConfig = {
  mode: "normal",
  redact: true,
  neverInclude: [...DEFAULT_NEVER_INCLUDE],
  extraRedactPatterns: [],
};

export const OUTPUT_CONFIG_DEFAULTS: OutputConfig = {
  includeManifestFooter: true,
  includeTokenReport: true,
  pathDisplay: "relative",
  storeRuns: true,
  runsDir: ".ctx/runs",
};

export const DEFAULT_CTX_CONFIG: CtxConfig = {
  defaults: DEFAULTS_CONFIG,
  repo: REPO_CONFIG_DEFAULTS,
  index: INDEX_CONFIG_DEFAULTS,
  discovery: DISCOVERY_CONFIG_DEFAULTS,
  localCli: LOCAL_CLI_CONFIG_DEFAULTS,
  git: GIT_CONFIG_DEFAULTS,
  privacy: PRIVACY_CONFIG_DEFAULTS,
  output: OUTPUT_CONFIG_DEFAULTS,
};

export function createDefaultCtxConfig(): CtxConfig {
  return {
    defaults: { ...DEFAULTS_CONFIG },
    repo: {
      ...REPO_CONFIG_DEFAULTS,
      ignore: [...REPO_CONFIG_DEFAULTS.ignore],
    },
    index: { ...INDEX_CONFIG_DEFAULTS },
    discovery: { ...DISCOVERY_CONFIG_DEFAULTS },
    localCli: {
      ...LOCAL_CLI_CONFIG_DEFAULTS,
      agentPriority: [...LOCAL_CLI_CONFIG_DEFAULTS.agentPriority],
    },
    git: { ...GIT_CONFIG_DEFAULTS },
    privacy: {
      ...PRIVACY_CONFIG_DEFAULTS,
      neverInclude: [...PRIVACY_CONFIG_DEFAULTS.neverInclude],
      extraRedactPatterns: [...PRIVACY_CONFIG_DEFAULTS.extraRedactPatterns],
    },
    output: { ...OUTPUT_CONFIG_DEFAULTS },
  };
}
