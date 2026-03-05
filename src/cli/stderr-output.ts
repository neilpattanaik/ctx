import type { CliOptions } from "./parse-args";

export interface StderrReporterRuntime {
  stderr(message: string): void;
}

export interface TokenSummaryInput {
  budget: number;
  estimated: number;
  fullFiles: number;
  sliceFiles: number;
  codemapFiles: number;
}

function sanitizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function sanitizeTimingMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function toModeLabel(options: CliOptions): string {
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

function toModelLabel(options: CliOptions): string {
  return options.model?.trim() || "default";
}

export class CliStderrReporter {
  private readonly quiet: boolean;
  private readonly verbose: boolean;
  private readonly runtime: StderrReporterRuntime;

  constructor(options: CliOptions, runtime: StderrReporterRuntime) {
    this.quiet = options.quiet;
    this.verbose = options.verbose;
    this.runtime = runtime;
  }

  private emitProgress(message: string, timingMs?: number): void {
    if (this.quiet) {
      return;
    }

    if (this.verbose && typeof timingMs === "number") {
      this.runtime.stderr(`${message} (${sanitizeTimingMs(timingMs)}ms)`);
      return;
    }

    this.runtime.stderr(message);
  }

  private emitWarning(message: string): void {
    if (this.quiet) {
      return;
    }
    this.runtime.stderr(`Warning: ${message}`);
  }

  scanningRepository(timingMs?: number): void {
    this.emitProgress("Scanning repository...", timingMs);
  }

  updatingIndex(timingMs?: number): void {
    this.emitProgress("Updating index...", timingMs);
  }

  discoveryBackend(options: CliOptions, timingMs?: number): void {
    this.emitProgress(
      `Discovery: using ${toModeLabel(options)} (${toModelLabel(options)})`,
      timingMs,
    );
  }

  discoveryTurn(turn: number, maxTurns: number, timingMs?: number): void {
    const safeTurn = Math.max(1, sanitizeCount(turn));
    const safeMaxTurns = Math.max(safeTurn, sanitizeCount(maxTurns));
    this.emitProgress(`Discovery: turn ${safeTurn}/${safeMaxTurns}...`, timingMs);
  }

  assemblingPrompt(timingMs?: number): void {
    this.emitProgress("Assembling prompt...", timingMs);
  }

  tokenSummary(summary: TokenSummaryInput): void {
    const fullFiles = sanitizeCount(summary.fullFiles);
    const sliceFiles = sanitizeCount(summary.sliceFiles);
    const codemapFiles = sanitizeCount(summary.codemapFiles);
    const totalFiles = fullFiles + sliceFiles + codemapFiles;

    this.emitProgress(
      `Budget: ${sanitizeCount(summary.budget)} | Estimated: ${sanitizeCount(summary.estimated)} | Files: ${totalFiles} (${fullFiles} full, ${sliceFiles} slices, ${codemapFiles} codemap)`,
    );
  }

  warnNoApiKeyFallback(): void {
    this.emitWarning("no API key configured, using offline discovery");
  }

  warnOversizedFiles(excludedFilesCount: number): void {
    const count = sanitizeCount(excludedFilesCount);
    this.emitWarning(`${count} files exceeded size limit`);
  }

  warnBudgetDegradations(degradationCount: number): void {
    const count = sanitizeCount(degradationCount);
    this.emitWarning(`budget exceeded, applied ${count} degradations`);
  }

  warnRedactedSecrets(secretCount: number): void {
    const count = sanitizeCount(secretCount);
    this.emitWarning(`redacted ${count} secrets`);
  }
}
