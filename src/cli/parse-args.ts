import type {
  CacheMode,
  CodemapMode,
  CtxMode,
  DiscoverMode,
  OutputFormat,
  PrivacyMode,
  TreeMode,
} from "../types";

type OnOff = "on" | "off";
type TemplatesAction = "list" | "show";

export type CtxSubcommand =
  | "init"
  | "agents"
  | "index"
  | "templates"
  | "explain"
  | "manifest"
  | "open";

export interface CliOptions {
  mode?: CtxMode;
  format?: OutputFormat;
  output?: string;
  copy: boolean;
  quiet: boolean;
  verbose: boolean;
  jsonSummary: boolean;
  budget?: number;
  reserve?: number;
  maxFiles?: number;
  maxFullFiles?: number;
  maxSlicesPerFile?: number;
  maxFileBytes?: number;
  failOnOverbudget: boolean;
  discover?: DiscoverMode;
  agent?: string;
  model?: string;
  agentTimeout?: number;
  agentMaxTurns?: number;
  noLlm: boolean;
  dryRun: boolean;
  repo?: string;
  cache?: CacheMode;
  cacheDir?: string;
  noIndex: boolean;
  tree?: TreeMode;
  codemaps?: CodemapMode;
  lineNumbers?: OnOff;
  include: string[];
  exclude: string[];
  preferFull: string[];
  preferSlices: string[];
  preferCodemap: string[];
  entrypoint: string[];
  diff?: string;
  gitStatus?: OnOff;
  gitMaxFiles?: number;
  gitMaxPatchTokens?: number;
  privacy?: PrivacyMode;
  redact?: OnOff;
  redactPattern: string[];
  neverInclude: string[];
  rebuild: boolean;
  help: boolean;
}

interface ParsedBaseCommand {
  options: CliOptions;
}

export interface ParsedMainCommand extends ParsedBaseCommand {
  kind: "main";
  taskText: string | null;
}

export interface ParsedInitCommand extends ParsedBaseCommand {
  kind: "init";
}

export interface ParsedAgentsCommand extends ParsedBaseCommand {
  kind: "agents";
}

export interface ParsedIndexCommand extends ParsedBaseCommand {
  kind: "index";
}

export interface ParsedTemplatesCommand extends ParsedBaseCommand {
  kind: "templates";
  action: TemplatesAction;
  name?: string;
}

export interface ParsedExplainCommand extends ParsedBaseCommand {
  kind: "explain";
  target: string;
}

export interface ParsedManifestCommand extends ParsedBaseCommand {
  kind: "manifest";
  target: string;
}

export interface ParsedOpenCommand extends ParsedBaseCommand {
  kind: "open";
  target: string;
}

export type ParsedCommand =
  | ParsedMainCommand
  | ParsedInitCommand
  | ParsedAgentsCommand
  | ParsedIndexCommand
  | ParsedTemplatesCommand
  | ParsedExplainCommand
  | ParsedManifestCommand
  | ParsedOpenCommand;

export type CliParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: string; exitCode: 2 };

const MODE_VALUES = ["plan", "question", "review", "context"] as const;
const FORMAT_VALUES = ["markdown", "markdown+xmltags", "xml", "plain"] as const;
const DISCOVER_VALUES = ["auto", "llm", "local-cli", "offline"] as const;
const CACHE_VALUES = ["repo", "global", "off"] as const;
const TREE_VALUES = ["auto", "full", "selected", "none"] as const;
const CODEMAP_VALUES = ["auto", "selected", "none", "complete"] as const;
const ON_OFF_VALUES = ["on", "off"] as const;
const PRIVACY_VALUES = ["normal", "strict", "airgap"] as const;

interface OptionDefinition {
  key: keyof CliOptions;
  type: "boolean" | "string" | "number" | "enum";
  values?: readonly string[];
  repeatable?: boolean;
  min?: number;
}

const LONG_OPTION_DEFS: Record<string, OptionDefinition> = {
  "--mode": { key: "mode", type: "enum", values: MODE_VALUES },
  "--format": { key: "format", type: "enum", values: FORMAT_VALUES },
  "--output": { key: "output", type: "string" },
  "--copy": { key: "copy", type: "boolean" },
  "--clipboard": { key: "copy", type: "boolean" },
  "--quiet": { key: "quiet", type: "boolean" },
  "--verbose": { key: "verbose", type: "boolean" },
  "--json-summary": { key: "jsonSummary", type: "boolean" },
  "--budget": { key: "budget", type: "number", min: 0 },
  "--reserve": { key: "reserve", type: "number", min: 0 },
  "--max-files": { key: "maxFiles", type: "number", min: 0 },
  "--max-full-files": { key: "maxFullFiles", type: "number", min: 0 },
  "--max-slices-per-file": { key: "maxSlicesPerFile", type: "number", min: 0 },
  "--max-file-bytes": { key: "maxFileBytes", type: "number", min: 0 },
  "--fail-on-overbudget": { key: "failOnOverbudget", type: "boolean" },
  "--discover": { key: "discover", type: "enum", values: DISCOVER_VALUES },
  "--agent": { key: "agent", type: "string" },
  "--model": { key: "model", type: "string" },
  "--agent-timeout": { key: "agentTimeout", type: "number", min: 1 },
  "--agent-max-turns": { key: "agentMaxTurns", type: "number", min: 1 },
  "--no-llm": { key: "noLlm", type: "boolean" },
  "--dry-run": { key: "dryRun", type: "boolean" },
  "--repo": { key: "repo", type: "string" },
  "--cache": { key: "cache", type: "enum", values: CACHE_VALUES },
  "--cache-dir": { key: "cacheDir", type: "string" },
  "--no-index": { key: "noIndex", type: "boolean" },
  "--tree": { key: "tree", type: "enum", values: TREE_VALUES },
  "--codemaps": { key: "codemaps", type: "enum", values: CODEMAP_VALUES },
  "--line-numbers": { key: "lineNumbers", type: "enum", values: ON_OFF_VALUES },
  "--include": { key: "include", type: "string", repeatable: true },
  "--exclude": { key: "exclude", type: "string", repeatable: true },
  "--prefer-full": { key: "preferFull", type: "string", repeatable: true },
  "--prefer-slices": { key: "preferSlices", type: "string", repeatable: true },
  "--prefer-codemap": {
    key: "preferCodemap",
    type: "string",
    repeatable: true,
  },
  "--entrypoint": { key: "entrypoint", type: "string", repeatable: true },
  "--diff": { key: "diff", type: "string" },
  "--git-status": { key: "gitStatus", type: "enum", values: ON_OFF_VALUES },
  "--git-max-files": { key: "gitMaxFiles", type: "number", min: 0 },
  "--git-max-patch-tokens": {
    key: "gitMaxPatchTokens",
    type: "number",
    min: 0,
  },
  "--privacy": { key: "privacy", type: "enum", values: PRIVACY_VALUES },
  "--redact": { key: "redact", type: "enum", values: ON_OFF_VALUES },
  "--redact-pattern": { key: "redactPattern", type: "string", repeatable: true },
  "--never-include": { key: "neverInclude", type: "string", repeatable: true },
  "--rebuild": { key: "rebuild", type: "boolean" },
  "--help": { key: "help", type: "boolean" },
};

const SHORT_OPTION_ALIASES: Record<string, string> = {
  h: "--help",
  o: "--output",
};

const SUBCOMMANDS = new Set<CtxSubcommand>([
  "init",
  "agents",
  "index",
  "templates",
  "explain",
  "manifest",
  "open",
]);

function createDefaultCliOptions(): CliOptions {
  return {
    copy: false,
    quiet: false,
    verbose: false,
    jsonSummary: false,
    failOnOverbudget: false,
    noLlm: false,
    dryRun: false,
    noIndex: false,
    include: [],
    exclude: [],
    preferFull: [],
    preferSlices: [],
    preferCodemap: [],
    entrypoint: [],
    redactPattern: [],
    neverInclude: [],
    rebuild: false,
    help: false,
  };
}

function invalidUsage(error: string): CliParseResult {
  return { ok: false, error, exitCode: 2 };
}

function parseNumberFlag(raw: string, flag: string, min = 0): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }

  if (parsed < min) {
    return null;
  }

  return parsed;
}

function parseValue(
  options: CliOptions,
  flag: string,
  definition: OptionDefinition,
  rawValue: string | boolean,
): string | null {
  const mutableOptions = options as Record<string, unknown>;

  if (definition.type === "boolean") {
    mutableOptions[definition.key] = true;
    return null;
  }

  if (typeof rawValue !== "string") {
    return `Option ${flag} requires a value.`;
  }

  if (definition.type === "number") {
    const parsed = parseNumberFlag(rawValue, flag, definition.min ?? 0);
    if (parsed === null) {
      return `Option ${flag} expects an integer >= ${definition.min ?? 0}.`;
    }

    mutableOptions[definition.key] = parsed;
    return null;
  }

  if (definition.type === "enum") {
    if (!definition.values?.includes(rawValue)) {
      return `Option ${flag} must be one of: ${definition.values?.join(", ")}.`;
    }

    mutableOptions[definition.key] = rawValue;
    return null;
  }

  if (definition.repeatable) {
    (mutableOptions[definition.key] as string[]).push(rawValue);
    return null;
  }

  mutableOptions[definition.key] = rawValue;
  return null;
}

function parseOptionTokens(tokens: readonly string[]): {
  options: CliOptions;
  positionals: string[];
  error?: string;
} {
  const options = createDefaultCliOptions();
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      const definition = LONG_OPTION_DEFS[flag];

      if (!definition) {
        return {
          options,
          positionals,
          error: `Unknown option: ${flag}`,
        };
      }

      if (definition.type === "boolean") {
        if (inlineValue !== undefined) {
          return {
            options,
            positionals,
            error: `Option ${flag} does not take a value.`,
          };
        }

        const error = parseValue(options, flag, definition, true);
        if (error) {
          return { options, positionals, error };
        }

        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        const nextToken = tokens[index + 1];
        if (nextToken === undefined || nextToken === "--") {
          return {
            options,
            positionals,
            error: `Option ${flag} requires a value.`,
          };
        }

        value = nextToken;
        index += 1;
      }

      const error = parseValue(options, flag, definition, value);
      if (error) {
        return { options, positionals, error };
      }

      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      if (token.length !== 2) {
        return {
          options,
          positionals,
          error: `Unknown short option: ${token}`,
        };
      }

      const aliasedFlag = SHORT_OPTION_ALIASES[token[1]];
      if (!aliasedFlag) {
        return {
          options,
          positionals,
          error: `Unknown short option: ${token}`,
        };
      }

      const definition = LONG_OPTION_DEFS[aliasedFlag];
      if (definition.type === "boolean") {
        const error = parseValue(options, aliasedFlag, definition, true);
        if (error) {
          return { options, positionals, error };
        }
        continue;
      }

      const nextToken = tokens[index + 1];
      if (nextToken === undefined || nextToken === "--") {
        return {
          options,
          positionals,
          error: `Option ${token} requires a value.`,
        };
      }

      index += 1;
      const error = parseValue(options, aliasedFlag, definition, nextToken);
      if (error) {
        return { options, positionals, error };
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const firstArg = argv[0];
  const subcommand =
    firstArg && SUBCOMMANDS.has(firstArg as CtxSubcommand)
      ? (firstArg as CtxSubcommand)
      : null;
  const rawTokens = subcommand ? argv.slice(1) : argv;
  const parsedTokens = parseOptionTokens(rawTokens);

  if (parsedTokens.error) {
    return invalidUsage(parsedTokens.error);
  }

  const { options, positionals } = parsedTokens;

  if (options.noLlm && options.discover === "llm") {
    return invalidUsage("Options --no-llm and --discover llm are mutually exclusive.");
  }

  if (subcommand === null) {
    return {
      ok: true,
      value: {
        kind: "main",
        taskText: positionals.length > 0 ? positionals.join(" ") : null,
        options,
      },
    };
  }

  switch (subcommand) {
    case "init":
      if (positionals.length > 0) {
        return invalidUsage("Subcommand init does not take positional arguments.");
      }
      return { ok: true, value: { kind: "init", options } };

    case "agents":
      if (positionals.length > 0) {
        return invalidUsage("Subcommand agents does not take positional arguments.");
      }
      return { ok: true, value: { kind: "agents", options } };

    case "index":
      if (positionals.length > 0) {
        return invalidUsage("Subcommand index does not take positional arguments.");
      }
      return { ok: true, value: { kind: "index", options } };

    case "templates": {
      const [action, name, ...rest] = positionals;
      if (!action) {
        return invalidUsage("Subcommand templates requires an action: list|show.");
      }

      if (action !== "list" && action !== "show") {
        return invalidUsage("Subcommand templates action must be list or show.");
      }

      if (action === "show" && !name) {
        return invalidUsage("Subcommand templates show requires a template name.");
      }

      if (action === "list" && name) {
        return invalidUsage("Subcommand templates list does not take extra arguments.");
      }

      if (rest.length > 0) {
        return invalidUsage("Subcommand templates received too many positional arguments.");
      }

      return {
        ok: true,
        value: {
          kind: "templates",
          action,
          name,
          options,
        },
      };
    }

    case "explain":
      if (positionals.length > 1) {
        return invalidUsage("Subcommand explain accepts at most one target.");
      }
      return {
        ok: true,
        value: {
          kind: "explain",
          target: positionals[0] ?? "last",
          options,
        },
      };

    case "manifest":
      if (positionals.length > 1) {
        return invalidUsage("Subcommand manifest accepts at most one target.");
      }
      return {
        ok: true,
        value: {
          kind: "manifest",
          target: positionals[0] ?? "last",
          options,
        },
      };

    case "open":
      if (positionals.length > 1) {
        return invalidUsage("Subcommand open accepts at most one target.");
      }
      return {
        ok: true,
        value: {
          kind: "open",
          target: positionals[0] ?? "last",
          options,
        },
      };

    default:
      return invalidUsage(`Unknown subcommand: ${subcommand}`);
  }
}

export function renderHelp(): string {
  return [
    "ctx - deterministic context builder",
    "",
    "Usage:",
    "  ctx [TASK_TEXT] [flags]",
    "  ctx init | agents | index [--rebuild]",
    "  ctx templates (list|show <name>)",
    "  ctx explain (last|<run-id>)",
    "  ctx manifest (last|<run-id>) [-o <path>]",
    "  ctx open (last|<run-id>)",
  ].join("\n");
}
