import {
  runClaudeCliDiscoveryAdapter,
  type ClaudeCliDiscoveryAdapterResult,
  type ClaudeCliInvocationResult,
} from "./claude-cli-adapter";

export interface CodexCliInvocationRequest {
  command: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
}

export type CodexCliInvocation = (
  request: CodexCliInvocationRequest,
) => Promise<ClaudeCliInvocationResult>;

export interface CodexCliDiscoveryAdapterOptions {
  command: string;
  model?: string;
  availablePaths: string[];
  systemPrompt: string;
  initialUserPrompt: string;
  maxTurns: number;
  timeoutMs: number;
  offlineDiscovery: import("../types").DiscoveryResult;
  runCodexCli: CodexCliInvocation;
  dispatchToolCalls: (
    calls: readonly import("../tools").ToolCall<Record<string, unknown>>[],
  ) => Promise<{ envelopes: string[] }>;
  sleep?: (ms: number) => Promise<void>;
  maxSelectionEntries?: number;
  now?: () => number;
}

export type CodexCliDiscoveryAdapterResult = ClaudeCliDiscoveryAdapterResult;

export async function runCodexCliDiscoveryAdapter(
  options: CodexCliDiscoveryAdapterOptions,
): Promise<CodexCliDiscoveryAdapterResult> {
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
      options.runCodexCli({
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
