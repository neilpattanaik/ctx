import type { CtxConfig } from "../types";
import { createDefaultCtxConfig } from "./schema";
import type { PartialCtxConfig } from "./parser";

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }
  return value;
}

function mergeSection<T extends Record<string, unknown>>(
  base: T,
  ...overlays: Array<Partial<T> | null | undefined>
): T {
  const result: Record<string, unknown> = { ...base };
  for (const overlay of overlays) {
    if (!overlay) {
      continue;
    }
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) {
        continue;
      }
      result[key] = cloneValue(value);
    }
  }
  return result as T;
}

function applyPrivacyModeRouting(config: CtxConfig): CtxConfig {
  if (config.privacy.mode !== "airgap") {
    return config;
  }

  if (
    config.discovery.discover === "llm" ||
    config.discovery.discover === "local-cli"
  ) {
    throw new Error(
      "privacy mode 'airgap' is incompatible with discover mode 'llm' or 'local-cli'",
    );
  }

  return {
    ...config,
    discovery: {
      ...config.discovery,
      discover: "offline",
    },
  };
}

export function mergeConfigPrecedence(options?: {
  defaults?: CtxConfig;
  userConfig?: PartialCtxConfig | null;
  repoConfig?: PartialCtxConfig | null;
  envConfig?: PartialCtxConfig | null;
  cliOverrides?: PartialCtxConfig | null;
}): CtxConfig {
  const defaults = options?.defaults ?? createDefaultCtxConfig();
  const userConfig = options?.userConfig;
  const repoConfig = options?.repoConfig;
  const envConfig = options?.envConfig;
  const cliOverrides = options?.cliOverrides;

  const merged: CtxConfig = {
    defaults: mergeSection(
      defaults.defaults,
      userConfig?.defaults,
      repoConfig?.defaults,
      envConfig?.defaults,
      cliOverrides?.defaults,
    ),
    repo: mergeSection(
      defaults.repo,
      userConfig?.repo,
      repoConfig?.repo,
      envConfig?.repo,
      cliOverrides?.repo,
    ),
    index: mergeSection(
      defaults.index,
      userConfig?.index,
      repoConfig?.index,
      envConfig?.index,
      cliOverrides?.index,
    ),
    discovery: mergeSection(
      defaults.discovery,
      userConfig?.discovery,
      repoConfig?.discovery,
      envConfig?.discovery,
      cliOverrides?.discovery,
    ),
    localCli: mergeSection(
      defaults.localCli,
      userConfig?.localCli,
      repoConfig?.localCli,
      envConfig?.localCli,
      cliOverrides?.localCli,
    ),
    git: mergeSection(
      defaults.git,
      userConfig?.git,
      repoConfig?.git,
      envConfig?.git,
      cliOverrides?.git,
    ),
    privacy: mergeSection(
      defaults.privacy,
      userConfig?.privacy,
      repoConfig?.privacy,
      envConfig?.privacy,
      cliOverrides?.privacy,
    ),
    output: mergeSection(
      defaults.output,
      userConfig?.output,
      repoConfig?.output,
      envConfig?.output,
      cliOverrides?.output,
    ),
  };

  return applyPrivacyModeRouting(merged);
}
