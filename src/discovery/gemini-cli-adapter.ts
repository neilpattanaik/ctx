import {
  runClaudeCliDiscoveryAdapter,
  type ClaudeCliDiscoveryAdapterResult,
  type ClaudeCliInvocationResult,
} from "./claude-cli-adapter";

export interface GeminiCliInvocationRequest {
  command: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
}

export type GeminiCliInvocation = (
  request: GeminiCliInvocationRequest,
) => Promise<ClaudeCliInvocationResult>;

export interface GeminiCliDiscoveryAdapterOptions {
  command: string;
  model?: string;
  availablePaths: string[];
  systemPrompt: string;
  initialUserPrompt: string;
  maxTurns: number;
  timeoutMs: number;
  offlineDiscovery: import("../types").DiscoveryResult;
  runGeminiCli: GeminiCliInvocation;
  dispatchToolCalls: (
    calls: readonly import("../tools").ToolCall<Record<string, unknown>>[],
  ) => Promise<{ envelopes: string[] }>;
  sleep?: (ms: number) => Promise<void>;
  maxSelectionEntries?: number;
  now?: () => number;
}

export type GeminiCliDiscoveryAdapterResult = ClaudeCliDiscoveryAdapterResult;

export async function runGeminiCliDiscoveryAdapter(
  options: GeminiCliDiscoveryAdapterOptions,
): Promise<GeminiCliDiscoveryAdapterResult> {
  return runClaudeCliDiscoveryAdapter({
    command: options.command,
    model: options.model,
    availablePaths: options.availablePaths,
    systemPrompt: options.systemPrompt,
    initialUserPrompt: options.initialUserPrompt,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs,
    offlineDiscovery: options.offlineDiscovery,
    runClaudeCli: async (request) =>
      options.runGeminiCli({
        command: request.command,
        model: request.model,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
      }),
    dispatchToolCalls: options.dispatchToolCalls,
    sleep: options.sleep,
    maxSelectionEntries: options.maxSelectionEntries,
    now: options.now,
  });
}
