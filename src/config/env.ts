import type { ConfigWarning } from "./parser";
import type { PartialCtxConfig } from "./parser";

export interface ProviderApiKeys {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

export interface ParseEnvOverridesOptions {
  env?: Record<string, string | undefined>;
  onWarning?: (warning: ConfigWarning) => void;
}

export interface EnvOverridesResult {
  config: PartialCtxConfig;
  providerKeys: ProviderApiKeys;
  warnings: ConfigWarning[];
}

const VALID_MODES = new Set(["plan", "question", "review", "context"]);
const VALID_FORMATS = new Set(["markdown", "markdown+xmltags", "xml", "plain"]);
const VALID_DISCOVER = new Set(["auto", "llm", "local-cli", "offline"]);
const VALID_PROVIDER = new Set(["openai", "anthropic", "google"]);

function pushWarning(
  warnings: ConfigWarning[],
  options: ParseEnvOverridesOptions | undefined,
  keyPath: string,
  message: string,
): void {
  const warning: ConfigWarning = {
    code: "invalid_value",
    filePath: "env",
    keyPath,
    message,
  };
  warnings.push(warning);
  options?.onWarning?.(warning);
}

function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseEnvOverrides(
  options?: ParseEnvOverridesOptions,
): EnvOverridesResult {
  const env = options?.env ?? process.env;
  const warnings: ConfigWarning[] = [];
  const config: PartialCtxConfig = {};
  const providerKeys: ProviderApiKeys = {};

  const repo = normalizeString(env.CTX_REPO);
  if (repo !== undefined) {
    config.repo = { ...(config.repo ?? {}), root: repo };
  }

  const budget = normalizeString(env.CTX_BUDGET);
  if (budget !== undefined) {
    const parsedBudget = parsePositiveInt(budget);
    if (parsedBudget === null) {
      pushWarning(
        warnings,
        options,
        "env.CTX_BUDGET",
        "CTX_BUDGET must be a positive integer",
      );
    } else {
      config.defaults = { ...(config.defaults ?? {}), budgetTokens: parsedBudget };
    }
  }

  const mode = normalizeString(env.CTX_MODE);
  if (mode !== undefined) {
    if (!VALID_MODES.has(mode)) {
      pushWarning(
        warnings,
        options,
        "env.CTX_MODE",
        "CTX_MODE must be one of: plan, question, review, context",
      );
    } else {
      config.defaults = {
        ...(config.defaults ?? {}),
        mode: mode as "plan" | "question" | "review" | "context",
      };
    }
  }

  const format = normalizeString(env.CTX_FORMAT);
  if (format !== undefined) {
    if (!VALID_FORMATS.has(format)) {
      pushWarning(
        warnings,
        options,
        "env.CTX_FORMAT",
        "CTX_FORMAT must be one of: markdown, markdown+xmltags, xml, plain",
      );
    } else {
      config.defaults = {
        ...(config.defaults ?? {}),
        format: format as "markdown" | "markdown+xmltags" | "xml" | "plain",
      };
    }
  }

  const discover = normalizeString(env.CTX_DISCOVER);
  if (discover !== undefined) {
    if (!VALID_DISCOVER.has(discover)) {
      pushWarning(
        warnings,
        options,
        "env.CTX_DISCOVER",
        "CTX_DISCOVER must be one of: auto, llm, local-cli, offline",
      );
    } else {
      config.discovery = {
        ...(config.discovery ?? {}),
        discover: discover as "auto" | "llm" | "local-cli" | "offline",
      };
    }
  }

  const provider = normalizeString(env.CTX_PROVIDER);
  if (provider !== undefined) {
    if (!VALID_PROVIDER.has(provider)) {
      pushWarning(
        warnings,
        options,
        "env.CTX_PROVIDER",
        "CTX_PROVIDER must be one of: openai, anthropic, google",
      );
    } else {
      config.discovery = {
        ...(config.discovery ?? {}),
        provider: provider as "openai" | "anthropic" | "google",
      };
    }
  }

  const model = normalizeString(env.CTX_MODEL);
  if (model !== undefined) {
    config.discovery = { ...(config.discovery ?? {}), model };
  }

  const openaiApiKey = normalizeString(env.OPENAI_API_KEY);
  const anthropicApiKey = normalizeString(env.ANTHROPIC_API_KEY);
  const googleApiKey = normalizeString(env.GOOGLE_API_KEY);
  if (openaiApiKey !== undefined) {
    providerKeys.openaiApiKey = openaiApiKey;
  }
  if (anthropicApiKey !== undefined) {
    providerKeys.anthropicApiKey = anthropicApiKey;
  }
  if (googleApiKey !== undefined) {
    providerKeys.googleApiKey = googleApiKey;
  }

  return { config, providerKeys, warnings };
}
