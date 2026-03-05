import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CtxConfig } from "../types";

export type PartialCtxConfig = {
  [K in keyof CtxConfig]?: Partial<CtxConfig[K]>;
};

export type ConfigWarningCode =
  | "parse_error"
  | "read_error"
  | "invalid_root"
  | "unknown_section"
  | "unknown_key"
  | "invalid_value";

export interface ConfigWarning {
  code: ConfigWarningCode;
  filePath: string;
  keyPath?: string;
  message: string;
}

export interface ParseTomlConfigOptions {
  onWarning?: (warning: ConfigWarning) => void;
}

const CTX_MODES = new Set(["plan", "question", "review", "context"]);
const OUTPUT_FORMATS = new Set(["markdown", "markdown+xmltags", "xml", "plain"]);
const TREE_MODES = new Set(["auto", "full", "selected", "none"]);
const CODEMAP_MODES = new Set(["auto", "selected", "none", "complete"]);
const DISCOVER_MODES = new Set(["auto", "llm", "local-cli", "offline"]);
const PROVIDERS = new Set(["openai", "anthropic", "google"]);
const INDEX_ENGINES = new Set(["sqlite", "memory"]);
const PRIVACY_MODES = new Set(["normal", "strict", "airgap"]);
const PATH_DISPLAY_MODES = new Set(["relative", "absolute"]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function emitWarning(
  warnings: ConfigWarning[],
  options: ParseTomlConfigOptions | undefined,
  warning: ConfigWarning,
): void {
  warnings.push(warning);
  options?.onWarning?.(warning);
}

function warnUnknownKeys(
  filePath: string,
  section: string,
  input: Record<string, unknown>,
  allowed: readonly string[],
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input).sort()) {
    if (allowedSet.has(key)) {
      continue;
    }
    emitWarning(warnings, options, {
      code: "unknown_key",
      filePath,
      keyPath: `${section}.${key}`,
      message: `Unknown key '${key}' in section [${section}]`,
    });
  }
}

function readString(
  input: Record<string, unknown>,
  key: string,
  filePath: string,
  section: string,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): string | undefined {
  if (!hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value === "string") {
    return value;
  }
  emitWarning(warnings, options, {
    code: "invalid_value",
    filePath,
    keyPath: `${section}.${key}`,
    message: `Expected string for ${section}.${key}`,
  });
  return undefined;
}

function readBoolean(
  input: Record<string, unknown>,
  key: string,
  filePath: string,
  section: string,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): boolean | undefined {
  if (!hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value === "boolean") {
    return value;
  }
  emitWarning(warnings, options, {
    code: "invalid_value",
    filePath,
    keyPath: `${section}.${key}`,
    message: `Expected boolean for ${section}.${key}`,
  });
  return undefined;
}

function readPositiveInteger(
  input: Record<string, unknown>,
  key: string,
  filePath: string,
  section: string,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): number | undefined {
  if (!hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  emitWarning(warnings, options, {
    code: "invalid_value",
    filePath,
    keyPath: `${section}.${key}`,
    message: `Expected positive integer for ${section}.${key}`,
  });
  return undefined;
}

function readStringArray(
  input: Record<string, unknown>,
  key: string,
  filePath: string,
  section: string,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): string[] | undefined {
  if (!hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  emitWarning(warnings, options, {
    code: "invalid_value",
    filePath,
    keyPath: `${section}.${key}`,
    message: `Expected string[] for ${section}.${key}`,
  });
  return undefined;
}

function readEnumValue<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: Set<T>,
  filePath: string,
  section: string,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): T | undefined {
  if (!hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value === "string" && allowed.has(value as T)) {
    return value as T;
  }
  emitWarning(warnings, options, {
    code: "invalid_value",
    filePath,
    keyPath: `${section}.${key}`,
    message: `Invalid value for ${section}.${key}`,
  });
  return undefined;
}

function validateDefaults(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["defaults"]> {
  warnUnknownKeys(
    filePath,
    "defaults",
    input,
    [
      "mode",
      "format",
      "budget_tokens",
      "reserve_tokens",
      "tree_mode",
      "codemaps",
      "max_files",
      "max_full_files",
      "max_slices_per_file",
      "line_numbers",
    ],
    warnings,
    options,
  );

  const result: Partial<CtxConfig["defaults"]> = {};
  const mode = readEnumValue(
    input,
    "mode",
    CTX_MODES,
    filePath,
    "defaults",
    warnings,
    options,
  );
  const format = readEnumValue(
    input,
    "format",
    OUTPUT_FORMATS,
    filePath,
    "defaults",
    warnings,
    options,
  );
  const budgetTokens = readPositiveInteger(
    input,
    "budget_tokens",
    filePath,
    "defaults",
    warnings,
    options,
  );
  const reserveTokens = readPositiveInteger(
    input,
    "reserve_tokens",
    filePath,
    "defaults",
    warnings,
    options,
  );
  const treeMode = readEnumValue(
    input,
    "tree_mode",
    TREE_MODES,
    filePath,
    "defaults",
    warnings,
    options,
  );
  const codemaps = readEnumValue(
    input,
    "codemaps",
    CODEMAP_MODES,
    filePath,
    "defaults",
    warnings,
    options,
  );
  const maxFiles = readPositiveInteger(
    input,
    "max_files",
    filePath,
    "defaults",
    warnings,
    options,
  );
  const maxFullFiles = readPositiveInteger(
    input,
    "max_full_files",
    filePath,
    "defaults",
    warnings,
    options,
  );
  const maxSlicesPerFile = readPositiveInteger(
    input,
    "max_slices_per_file",
    filePath,
    "defaults",
    warnings,
    options,
  );
  const lineNumbers = readBoolean(
    input,
    "line_numbers",
    filePath,
    "defaults",
    warnings,
    options,
  );

  if (mode !== undefined) result.mode = mode;
  if (format !== undefined) result.format = format;
  if (budgetTokens !== undefined) result.budgetTokens = budgetTokens;
  if (reserveTokens !== undefined) result.reserveTokens = reserveTokens;
  if (treeMode !== undefined) result.treeMode = treeMode;
  if (codemaps !== undefined) result.codemaps = codemaps;
  if (maxFiles !== undefined) result.maxFiles = maxFiles;
  if (maxFullFiles !== undefined) result.maxFullFiles = maxFullFiles;
  if (maxSlicesPerFile !== undefined) result.maxSlicesPerFile = maxSlicesPerFile;
  if (lineNumbers !== undefined) result.lineNumbers = lineNumbers;
  return result;
}

function validateRepo(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["repo"]> {
  warnUnknownKeys(
    filePath,
    "repo",
    input,
    ["root", "use_gitignore", "ignore", "max_file_bytes", "skip_binary"],
    warnings,
    options,
  );

  const result: Partial<CtxConfig["repo"]> = {};
  const root = readString(input, "root", filePath, "repo", warnings, options);
  const useGitignore = readBoolean(
    input,
    "use_gitignore",
    filePath,
    "repo",
    warnings,
    options,
  );
  const ignore = readStringArray(
    input,
    "ignore",
    filePath,
    "repo",
    warnings,
    options,
  );
  const maxFileBytes = readPositiveInteger(
    input,
    "max_file_bytes",
    filePath,
    "repo",
    warnings,
    options,
  );
  const skipBinary = readBoolean(
    input,
    "skip_binary",
    filePath,
    "repo",
    warnings,
    options,
  );

  if (root !== undefined) result.root = root;
  if (useGitignore !== undefined) result.useGitignore = useGitignore;
  if (ignore !== undefined) result.ignore = ignore;
  if (maxFileBytes !== undefined) result.maxFileBytes = maxFileBytes;
  if (skipBinary !== undefined) result.skipBinary = skipBinary;
  return result;
}

function validateIndex(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["index"]> {
  warnUnknownKeys(
    filePath,
    "index",
    input,
    ["enabled", "engine", "rebuild_on_schema_change"],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["index"]> = {};
  const enabled = readBoolean(input, "enabled", filePath, "index", warnings, options);
  const engine = readEnumValue(
    input,
    "engine",
    INDEX_ENGINES,
    filePath,
    "index",
    warnings,
    options,
  );
  const rebuildOnSchemaChange = readBoolean(
    input,
    "rebuild_on_schema_change",
    filePath,
    "index",
    warnings,
    options,
  );
  if (enabled !== undefined) result.enabled = enabled;
  if (engine !== undefined) result.engine = engine;
  if (rebuildOnSchemaChange !== undefined) {
    result.rebuildOnSchemaChange = rebuildOnSchemaChange;
  }
  return result;
}

function validateDiscovery(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["discovery"]> {
  warnUnknownKeys(
    filePath,
    "discovery",
    input,
    ["discover", "provider", "model", "timeout_seconds", "max_turns"],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["discovery"]> = {};
  const discover = readEnumValue(
    input,
    "discover",
    DISCOVER_MODES,
    filePath,
    "discovery",
    warnings,
    options,
  );
  const provider = readEnumValue(
    input,
    "provider",
    PROVIDERS,
    filePath,
    "discovery",
    warnings,
    options,
  );
  const model = readString(
    input,
    "model",
    filePath,
    "discovery",
    warnings,
    options,
  );
  const timeoutSeconds = readPositiveInteger(
    input,
    "timeout_seconds",
    filePath,
    "discovery",
    warnings,
    options,
  );
  const maxTurns = readPositiveInteger(
    input,
    "max_turns",
    filePath,
    "discovery",
    warnings,
    options,
  );
  if (discover !== undefined) result.discover = discover;
  if (provider !== undefined) result.provider = provider;
  if (model !== undefined) result.model = model;
  if (timeoutSeconds !== undefined) result.timeoutSeconds = timeoutSeconds;
  if (maxTurns !== undefined) result.maxTurns = maxTurns;
  return result;
}

function validateLocalCli(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["localCli"]> {
  warnUnknownKeys(
    filePath,
    "local_cli",
    input,
    [
      "agent_priority",
      "codex_cli_command",
      "claude_cli_command",
      "gemini_cli_command",
    ],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["localCli"]> = {};
  const agentPriority = readStringArray(
    input,
    "agent_priority",
    filePath,
    "local_cli",
    warnings,
    options,
  );
  const codexCliCommand = readString(
    input,
    "codex_cli_command",
    filePath,
    "local_cli",
    warnings,
    options,
  );
  const claudeCliCommand = readString(
    input,
    "claude_cli_command",
    filePath,
    "local_cli",
    warnings,
    options,
  );
  const geminiCliCommand = readString(
    input,
    "gemini_cli_command",
    filePath,
    "local_cli",
    warnings,
    options,
  );
  if (agentPriority !== undefined) result.agentPriority = agentPriority;
  if (codexCliCommand !== undefined) result.codexCliCommand = codexCliCommand;
  if (claudeCliCommand !== undefined) result.claudeCliCommand = claudeCliCommand;
  if (geminiCliCommand !== undefined) result.geminiCliCommand = geminiCliCommand;
  return result;
}

function validateGit(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["git"]> {
  warnUnknownKeys(
    filePath,
    "git",
    input,
    ["diff", "git_status", "max_files", "max_patch_tokens"],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["git"]> = {};
  const diff = readString(input, "diff", filePath, "git", warnings, options);
  const gitStatus = readBoolean(
    input,
    "git_status",
    filePath,
    "git",
    warnings,
    options,
  );
  const maxFiles = readPositiveInteger(
    input,
    "max_files",
    filePath,
    "git",
    warnings,
    options,
  );
  const maxPatchTokens = readPositiveInteger(
    input,
    "max_patch_tokens",
    filePath,
    "git",
    warnings,
    options,
  );
  if (diff !== undefined) result.diff = diff;
  if (gitStatus !== undefined) result.gitStatus = gitStatus;
  if (maxFiles !== undefined) result.maxFiles = maxFiles;
  if (maxPatchTokens !== undefined) result.maxPatchTokens = maxPatchTokens;
  return result;
}

function validatePrivacy(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["privacy"]> {
  warnUnknownKeys(
    filePath,
    "privacy",
    input,
    ["mode", "redact", "never_include", "extra_redact_patterns"],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["privacy"]> = {};
  const mode = readEnumValue(
    input,
    "mode",
    PRIVACY_MODES,
    filePath,
    "privacy",
    warnings,
    options,
  );
  const redact = readBoolean(
    input,
    "redact",
    filePath,
    "privacy",
    warnings,
    options,
  );
  const neverInclude = readStringArray(
    input,
    "never_include",
    filePath,
    "privacy",
    warnings,
    options,
  );
  const extraRedactPatterns = readStringArray(
    input,
    "extra_redact_patterns",
    filePath,
    "privacy",
    warnings,
    options,
  );
  if (mode !== undefined) result.mode = mode;
  if (redact !== undefined) result.redact = redact;
  if (neverInclude !== undefined) result.neverInclude = neverInclude;
  if (extraRedactPatterns !== undefined) {
    result.extraRedactPatterns = extraRedactPatterns;
  }
  return result;
}

function validateOutput(
  filePath: string,
  input: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): Partial<CtxConfig["output"]> {
  warnUnknownKeys(
    filePath,
    "output",
    input,
    [
      "include_manifest_footer",
      "include_token_report",
      "path_display",
      "store_runs",
      "runs_dir",
    ],
    warnings,
    options,
  );
  const result: Partial<CtxConfig["output"]> = {};
  const includeManifestFooter = readBoolean(
    input,
    "include_manifest_footer",
    filePath,
    "output",
    warnings,
    options,
  );
  const includeTokenReport = readBoolean(
    input,
    "include_token_report",
    filePath,
    "output",
    warnings,
    options,
  );
  const pathDisplay = readEnumValue(
    input,
    "path_display",
    PATH_DISPLAY_MODES,
    filePath,
    "output",
    warnings,
    options,
  );
  const storeRuns = readBoolean(
    input,
    "store_runs",
    filePath,
    "output",
    warnings,
    options,
  );
  const runsDir = readString(input, "runs_dir", filePath, "output", warnings, options);
  if (includeManifestFooter !== undefined) {
    result.includeManifestFooter = includeManifestFooter;
  }
  if (includeTokenReport !== undefined) {
    result.includeTokenReport = includeTokenReport;
  }
  if (pathDisplay !== undefined) result.pathDisplay = pathDisplay;
  if (storeRuns !== undefined) result.storeRuns = storeRuns;
  if (runsDir !== undefined) result.runsDir = runsDir;
  return result;
}

function validateParsedTomlConfig(
  filePath: string,
  parsed: Record<string, unknown>,
  warnings: ConfigWarning[],
  options?: ParseTomlConfigOptions,
): PartialCtxConfig {
  const result: PartialCtxConfig = {};
  const sectionKeys = Object.keys(parsed).sort();
  for (const section of sectionKeys) {
    const sectionValue = parsed[section];
    const sectionObject = asRecord(sectionValue);
    if (sectionObject === null) {
      emitWarning(warnings, options, {
        code: "invalid_value",
        filePath,
        keyPath: section,
        message: `Expected table for section [${section}]`,
      });
      continue;
    }

    switch (section) {
      case "defaults": {
        const value = validateDefaults(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.defaults = value;
        }
        break;
      }
      case "repo": {
        const value = validateRepo(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.repo = value;
        }
        break;
      }
      case "index": {
        const value = validateIndex(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.index = value;
        }
        break;
      }
      case "discovery": {
        const value = validateDiscovery(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.discovery = value;
        }
        break;
      }
      case "local_cli": {
        const value = validateLocalCli(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.localCli = value;
        }
        break;
      }
      case "git": {
        const value = validateGit(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.git = value;
        }
        break;
      }
      case "privacy": {
        const value = validatePrivacy(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.privacy = value;
        }
        break;
      }
      case "output": {
        const value = validateOutput(filePath, sectionObject, warnings, options);
        if (Object.keys(value).length > 0) {
          result.output = value;
        }
        break;
      }
      default:
        emitWarning(warnings, options, {
          code: "unknown_section",
          filePath,
          keyPath: section,
          message: `Unknown config section [${section}]`,
        });
        break;
    }
  }
  return result;
}

export function parseTomlConfigFile(
  filePath: string,
  options?: ParseTomlConfigOptions,
): { config: PartialCtxConfig | null; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  if (!existsSync(filePath)) {
    return { config: null, warnings };
  }

  let rawText: string;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch (error) {
    emitWarning(warnings, options, {
      code: "read_error",
      filePath,
      message: `Failed to read config file: ${(error as Error).message}`,
    });
    return { config: null, warnings };
  }

  if (rawText.trim() === "") {
    return { config: {}, warnings };
  }

  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch (error) {
    emitWarning(warnings, options, {
      code: "parse_error",
      filePath,
      message: `Failed to parse TOML: ${(error as Error).message}`,
    });
    return { config: null, warnings };
  }

  const parsedObject = asRecord(parsed);
  if (parsedObject === null) {
    emitWarning(warnings, options, {
      code: "invalid_root",
      filePath,
      message: "Expected TOML document to parse into a table",
    });
    return { config: null, warnings };
  }

  return {
    config: validateParsedTomlConfig(filePath, parsedObject, warnings, options),
    warnings,
  };
}

export function parseRepoConfigFile(
  repoRoot: string,
  options?: ParseTomlConfigOptions,
): { config: PartialCtxConfig | null; warnings: ConfigWarning[] } {
  return parseTomlConfigFile(join(repoRoot, ".ctx", "config.toml"), options);
}

export function parseUserConfigFile(
  options?: ParseTomlConfigOptions,
): { config: PartialCtxConfig | null; warnings: ConfigWarning[] } {
  const configHome =
    process.env.XDG_CONFIG_HOME ??
    (process.env.HOME ? join(process.env.HOME, ".config") : null);
  if (!configHome) {
    return { config: null, warnings: [] };
  }
  return parseTomlConfigFile(join(configHome, "ctx", "config.toml"), options);
}
