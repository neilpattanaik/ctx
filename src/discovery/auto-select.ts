import type { ProviderApiKeys } from "../config/env";
import type { CtxConfig, DiscoveryProvider } from "../types";

type DiscoverBackend = "offline" | "llm" | "local-cli";

const PROVIDER_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_MODEL_LABEL = "default-model";

export interface ProviderHealthCheckInput {
  provider: DiscoveryProvider;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export type ProviderHealthCheck = (input: ProviderHealthCheckInput) => boolean;
export type LocalCliCommandCheck = (command: string) => boolean;

export interface ResolveDiscoveryBackendOptions {
  config: Pick<CtxConfig, "discovery" | "localCli" | "privacy">;
  providerKeys?: ProviderApiKeys;
  noLlm?: boolean;
  providerHealthCheck?: ProviderHealthCheck;
  localCliCommandCheck?: LocalCliCommandCheck;
}

export interface DiscoveryBackendSelection {
  discover: DiscoverBackend;
  provider?: DiscoveryProvider;
  model?: string;
  localCliAgent?: "codex-cli" | "claude-cli" | "gemini-cli";
  localCliCommand?: string;
  reason: string;
  logMessage: string;
}

interface LocalCliCandidate {
  agent: "codex-cli" | "claude-cli" | "gemini-cli";
  command: string;
}

interface ProviderStatus {
  available: boolean;
  reason: string;
  apiKey?: string;
}

function defaultProviderHealthCheck(_input: ProviderHealthCheckInput): boolean {
  return true;
}

function defaultLocalCliCommandCheck(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const bunRuntime = globalThis as unknown as {
    Bun?: { which?: (value: string) => string | null | undefined };
  };
  const which = bunRuntime.Bun?.which;
  if (typeof which !== "function") {
    return false;
  }
  try {
    return Boolean(which(trimmed));
  } catch {
    return false;
  }
}

function readProviderKey(
  provider: DiscoveryProvider,
  providerKeys: ProviderApiKeys | undefined,
): string | undefined {
  if (provider === "openai") {
    return providerKeys?.openaiApiKey;
  }
  if (provider === "anthropic") {
    return providerKeys?.anthropicApiKey;
  }
  return providerKeys?.googleApiKey;
}

function isLikelyValidProviderKey(provider: DiscoveryProvider, apiKey: string): boolean {
  if (provider === "openai") {
    return /^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey);
  }
  if (provider === "anthropic") {
    return /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(apiKey);
  }
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(apiKey);
}

function evaluateProviderStatus(
  options: ResolveDiscoveryBackendOptions,
): ProviderStatus {
  const provider = options.config.discovery.provider;
  const apiKey = readProviderKey(provider, options.providerKeys);
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return {
      available: false,
      reason: "no API key configured",
    };
  }

  if (!isLikelyValidProviderKey(provider, apiKey)) {
    return {
      available: false,
      reason: "API key format invalid",
    };
  }

  const providerHealthCheck = options.providerHealthCheck ?? defaultProviderHealthCheck;
  const reachable = providerHealthCheck({
    provider,
    apiKey,
    model: options.config.discovery.model,
    timeoutMs: PROVIDER_CHECK_TIMEOUT_MS,
  });
  if (!reachable) {
    return {
      available: false,
      reason: `${provider} API unreachable`,
    };
  }

  return {
    available: true,
    reason: "provider API key configured and reachable",
    apiKey,
  };
}

function normalizeAgentPriorityLabel(
  value: string,
): "codex-cli" | "claude-cli" | "gemini-cli" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex-cli" || normalized === "codex" || normalized === "codex_cli") {
    return "codex-cli";
  }
  if (normalized === "claude-cli" || normalized === "claude" || normalized === "claude_cli") {
    return "claude-cli";
  }
  if (normalized === "gemini-cli" || normalized === "gemini" || normalized === "gemini_cli") {
    return "gemini-cli";
  }
  return null;
}

function localCliCommandForAgent(
  agent: "codex-cli" | "claude-cli" | "gemini-cli",
  config: ResolveDiscoveryBackendOptions["config"],
): string {
  if (agent === "codex-cli") {
    return config.localCli.codexCliCommand;
  }
  if (agent === "claude-cli") {
    return config.localCli.claudeCliCommand;
  }
  return config.localCli.geminiCliCommand;
}

function buildLocalCliCandidates(
  options: ResolveDiscoveryBackendOptions,
): LocalCliCandidate[] {
  const seenAgents = new Set<string>();
  const candidates: LocalCliCandidate[] = [];
  for (const priorityItem of options.config.localCli.agentPriority) {
    const agent = normalizeAgentPriorityLabel(priorityItem);
    if (agent === null || seenAgents.has(agent)) {
      continue;
    }
    seenAgents.add(agent);
    const command = localCliCommandForAgent(agent, options.config).trim();
    if (command.length === 0) {
      continue;
    }
    candidates.push({ agent, command });
  }
  return candidates;
}

function pickAvailableLocalCli(
  options: ResolveDiscoveryBackendOptions,
): LocalCliCandidate | null {
  const localCliCommandCheck = options.localCliCommandCheck ?? defaultLocalCliCommandCheck;
  const candidates = buildLocalCliCandidates(options);
  for (const candidate of candidates) {
    if (localCliCommandCheck(candidate.command)) {
      return candidate;
    }
  }
  return null;
}

function toOffline(reason: string): DiscoveryBackendSelection {
  return {
    discover: "offline",
    reason,
    logMessage: `Discovery: using offline (${reason})`,
  };
}

function toLlmSelection(
  provider: DiscoveryProvider,
  model: string,
  reason: string,
): DiscoveryBackendSelection {
  const modelLabel = model.trim().length > 0 ? model : DEFAULT_MODEL_LABEL;
  return {
    discover: "llm",
    provider,
    model,
    reason,
    logMessage: `Discovery: using ${provider} API (${modelLabel})`,
  };
}

function toLocalCliSelection(
  candidate: LocalCliCandidate,
  reason: string,
): DiscoveryBackendSelection {
  return {
    discover: "local-cli",
    localCliAgent: candidate.agent,
    localCliCommand: candidate.command,
    reason,
    logMessage: `Discovery: using local-cli (${candidate.agent} via ${candidate.command})`,
  };
}

export function resolveDiscoveryBackend(
  options: ResolveDiscoveryBackendOptions,
): DiscoveryBackendSelection {
  if (options.config.privacy.mode === "airgap") {
    return toOffline("privacy airgap mode");
  }

  if (options.noLlm === true) {
    return toOffline("--no-llm set");
  }

  const discoverMode = options.config.discovery.discover;
  const provider = options.config.discovery.provider;
  const model = options.config.discovery.model;
  const providerStatus = evaluateProviderStatus(options);
  const localCliCandidate = pickAvailableLocalCli(options);

  if (discoverMode === "offline") {
    return toOffline("discover mode forced offline");
  }

  if (discoverMode === "llm") {
    if (providerStatus.available) {
      return toLlmSelection(provider, model, "discover mode forced llm");
    }
    if (localCliCandidate) {
      return toLocalCliSelection(
        localCliCandidate,
        `llm unavailable (${providerStatus.reason}), using local-cli fallback`,
      );
    }
    return toOffline(`llm unavailable (${providerStatus.reason})`);
  }

  if (discoverMode === "local-cli") {
    if (localCliCandidate) {
      return toLocalCliSelection(localCliCandidate, "discover mode forced local-cli");
    }
    return toOffline("local-cli unavailable");
  }

  if (providerStatus.available) {
    return toLlmSelection(provider, model, providerStatus.reason);
  }

  if (localCliCandidate) {
    return toLocalCliSelection(
      localCliCandidate,
      `provider unavailable (${providerStatus.reason}), using local-cli`,
    );
  }

  return toOffline(`provider unavailable (${providerStatus.reason}) and no local-cli found`);
}
