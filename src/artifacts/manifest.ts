import { basename } from "node:path";
import type { SelectionMode, SelectionPriority, SliceRange } from "../types";
import {
  loadRunRecordForExplain,
  type ExplainIo,
  type LoadedExplainRun,
} from "./explain";

type JsonObject = Record<string, unknown>;

interface ManifestSelectionEntry {
  path: string;
  mode: SelectionMode;
  priority: SelectionPriority;
  priorityScore?: number;
  rationale: string;
  slices?: Array<{
    startLine: number;
    endLine: number;
    description: string;
  }>;
  tokenEstimate?: number;
}

interface ManifestDroppedEntry {
  path: string;
  reason: string;
  priorityScore?: number;
}

interface ManifestDegradationEntry {
  step: string;
  action: string;
  path?: string;
  fromMode?: string;
  toMode?: string;
  tokensSaved: number;
}

export interface ManifestReport {
  runId: string;
  repo: {
    root: string;
    name: string;
    totalFiles: number;
    languages: Record<string, number>;
  };
  config: {
    budget: number;
    mode: string;
    format: string;
    privacy: string;
    discover: string;
    diff: string;
  };
  discovery: {
    backend: string;
    model?: string;
    turns?: number;
    duration?: number;
  };
  selection: ManifestSelectionEntry[];
  dropped: ManifestDroppedEntry[];
  tokenReport: {
    budget: number;
    estimated: number;
    bySection: Record<string, number>;
    byFile: Array<{ path: string; tokens: number }>;
  };
  degradations: ManifestDegradationEntry[];
  git: {
    diff_mode: string;
    changed_files_count: number;
    patch_tokens: number;
  };
}

type ParsedDegradation = {
  step: string;
  path?: string;
  fromMode?: string;
  toMode?: string;
  tokensSaved: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asInt(value: unknown, fallback = 0): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? (value as JsonObject) : null;
}

function parseSlices(value: unknown): SliceRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const slices: SliceRange[] = [];
  for (const candidate of value) {
    const obj = asObject(candidate);
    if (!obj) {
      continue;
    }
    const startLine = asInt(obj.startLine, -1);
    const endLine = asInt(obj.endLine, -1);
    if (startLine < 1 || endLine < startLine) {
      continue;
    }
    const description = asString(obj.description, "slice");
    const rationale = asString(obj.rationale, "n/a");
    slices.push({ startLine, endLine, description, rationale });
  }
  return slices;
}

function parseDegradationEntry(value: unknown): ParsedDegradation {
  const obj = asObject(value) ?? {};
  const step = asString(obj.step, asString(obj.action, "unknown"));
  const reason = asString(obj.reason);
  const tokensSaved = asInt(obj.tokensSaved, asInt(obj.delta, 0));

  const directPath = asString(obj.targetPath);
  const directFromMode = asString(obj.fromMode);
  const directToMode = asString(obj.toMode);
  if (directPath.length > 0) {
    return {
      step,
      path: directPath,
      fromMode: directFromMode || undefined,
      toMode: directToMode || undefined,
      tokensSaved,
    };
  }

  const degradeMatch = /^degrade (.+) ([a-z_]+)->([a-z_]+)$/.exec(reason);
  if (degradeMatch) {
    return {
      step,
      path: degradeMatch[1],
      fromMode: degradeMatch[2],
      toMode: degradeMatch[3],
      tokensSaved,
    };
  }

  const dropMatch = /^drop (.+) codemap_only$/.exec(reason);
  if (dropMatch) {
    return {
      step,
      path: dropMatch[1],
      fromMode: "codemap_only",
      tokensSaved,
    };
  }

  return { step, tokensSaved };
}

function normalizeLanguages(value: unknown): Record<string, number> {
  const languages = asObject(value);
  if (!languages) {
    return {};
  }

  const entries = Object.entries(languages)
    .filter((item): item is [string, number] => item[0].length > 0 && isFiniteNumber(item[1]))
    .map(([name, count]) => [name, Math.max(0, Math.floor(count))] as const)
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
    );

  return Object.fromEntries(entries);
}

function normalizeBySection(value: unknown): Record<string, number> {
  const bySection = asObject(value);
  if (!bySection) {
    return {};
  }

  const entries = Object.entries(bySection)
    .filter((item): item is [string, number] => item[0].length > 0 && isFiniteNumber(item[1]))
    .map(([name, tokens]) => [name, Math.max(0, Math.floor(tokens))] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));

  return Object.fromEntries(entries);
}

function normalizeByFile(value: unknown): Array<{ path: string; tokens: number }> {
  const byFile = asObject(value);
  if (!byFile) {
    return [];
  }

  return Object.entries(byFile)
    .filter((item): item is [string, number] => item[0].length > 0 && isFiniteNumber(item[1]))
    .map(([path, tokens]) => ({
      path,
      tokens: Math.max(0, Math.floor(tokens)),
    }))
    .sort((left, right) =>
      right.tokens === left.tokens
        ? left.path.localeCompare(right.path)
        : right.tokens - left.tokens,
    );
}

function normalizeSelection(record: JsonObject): ManifestSelectionEntry[] {
  const tokenByPath = new Map<string, number>(
    normalizeByFile(record.tokenReport && asObject(record.tokenReport)?.byFile).map(
      (item) => [item.path, item.tokens] as const,
    ),
  );
  const rawSelection = Array.isArray(record.selection) ? record.selection : [];
  const normalized: ManifestSelectionEntry[] = [];

  for (const candidate of rawSelection) {
    const obj = asObject(candidate);
    if (!obj) {
      continue;
    }

    const path = asString(obj.path);
    if (!path) {
      continue;
    }

    const modeRaw = asString(obj.mode);
    const mode: SelectionMode =
      modeRaw === "full" || modeRaw === "slices" || modeRaw === "codemap_only"
        ? modeRaw
        : "codemap_only";
    const priorityRaw = asString(obj.priority);
    const priority: SelectionPriority =
      priorityRaw === "core" || priorityRaw === "support" || priorityRaw === "ref"
        ? priorityRaw
        : "ref";
    const priorityScore = isFiniteNumber(obj.priorityScore)
      ? Math.floor(obj.priorityScore)
      : undefined;
    const entry: ManifestSelectionEntry = {
      path,
      mode,
      priority,
      rationale: asString(obj.rationale, "n/a"),
      tokenEstimate: tokenByPath.get(path),
    };

    if (priorityScore !== undefined) {
      entry.priorityScore = priorityScore;
    }

    if (mode === "slices") {
      const slices = parseSlices(obj.slices).map((slice) => ({
        startLine: slice.startLine,
        endLine: slice.endLine,
        description: slice.description,
      }));
      if (slices.length > 0) {
        entry.slices = slices;
      }
    }

    normalized.push(entry);
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeDegradations(record: JsonObject): ManifestDegradationEntry[] {
  const tokenReport = asObject(record.tokenReport);
  if (!tokenReport || !Array.isArray(tokenReport.degradations)) {
    return [];
  }

  return tokenReport.degradations.map((entry) => {
    const parsed = parseDegradationEntry(entry);
    const normalized: ManifestDegradationEntry = {
      step: parsed.step,
      action: parsed.step,
      tokensSaved: parsed.tokensSaved,
    };
    if (parsed.path) {
      normalized.path = parsed.path;
    }
    if (parsed.fromMode) {
      normalized.fromMode = parsed.fromMode;
    }
    if (parsed.toMode) {
      normalized.toMode = parsed.toMode;
    }
    return normalized;
  });
}

function normalizeDropped(record: JsonObject): ManifestDroppedEntry[] {
  const dedup = new Map<string, ManifestDroppedEntry>();
  const rawDropped = Array.isArray(record.dropped) ? record.dropped : [];

  for (const candidate of rawDropped) {
    const obj = asObject(candidate);
    if (!obj) {
      continue;
    }
    const path = asString(obj.path);
    if (!path || dedup.has(path)) {
      continue;
    }
    const entry: ManifestDroppedEntry = {
      path,
      reason: asString(obj.reason, "dropped"),
    };
    if (isFiniteNumber(obj.priorityScore)) {
      entry.priorityScore = Math.floor(obj.priorityScore);
    }
    dedup.set(path, entry);
  }

  for (const degradation of normalizeDegradations(record)) {
    if (degradation.step !== "drop_codemap_only" || !degradation.path) {
      continue;
    }
    if (dedup.has(degradation.path)) {
      continue;
    }
    dedup.set(degradation.path, {
      path: degradation.path,
      reason: "budget degradation",
    });
  }

  return [...dedup.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function loadRunRecordForManifest(options: {
  repoRoot: string;
  runsDir: string;
  target: string;
  io: ExplainIo;
}): LoadedExplainRun {
  return loadRunRecordForExplain(options);
}

export function buildManifestReport(
  input: LoadedExplainRun,
  repoRoot: string,
): ManifestReport {
  const record = asObject(input.record) ?? {};
  const config = asObject(record.config) ?? {};
  const defaults = asObject(config.defaults) ?? {};
  const repo = asObject(config.repo) ?? {};
  const discoveryConfig = asObject(config.discovery) ?? {};
  const git = asObject(config.git) ?? {};
  const privacy = asObject(config.privacy) ?? {};
  const tokenReport = asObject(record.tokenReport) ?? {};
  const timing = asObject(record.timing) ?? {};
  const phaseDurations = asObject(timing.phaseDurationsMs) ?? {};
  const recordRepo = asObject(record.repo);
  const recordLanguageStats = asObject(record.languageStats);
  const selection = normalizeSelection(record);
  const totalFilesFallback = selection.length;
  const reportRoot = asString(
    recordRepo?.root,
    asString(repo.root, repoRoot),
  );

  return {
    runId: asString(record.runId, input.runId),
    repo: {
      root: reportRoot,
      name: basename(reportRoot),
      totalFiles: asInt(recordRepo?.totalFiles, totalFilesFallback),
      languages: normalizeLanguages(recordRepo?.languages ?? recordLanguageStats),
    },
    config: {
      budget: asInt(tokenReport.budget, asInt(defaults.budgetTokens)),
      mode: asString(defaults.mode, "plan"),
      format: asString(defaults.format, "markdown+xmltags"),
      privacy: asString(privacy.mode, "normal"),
      discover: asString(discoveryConfig.discover, "offline"),
      diff: asString(git.diff, "off"),
    },
    discovery: {
      backend: asString(
        record.discoveryBackend,
        asString(discoveryConfig.discover, "unknown"),
      ),
      model: asString(discoveryConfig.model) || undefined,
      turns: asInt(record.discoveryTurns, asInt(discoveryConfig.maxTurns, 0)) || undefined,
      duration:
        asInt(record.discoveryDurationMs, asInt(phaseDurations.discovery, 0)) || undefined,
    },
    selection,
    dropped: normalizeDropped(record),
    tokenReport: {
      budget: asInt(tokenReport.budget),
      estimated: asInt(tokenReport.estimated),
      bySection: normalizeBySection(tokenReport.bySection),
      byFile: normalizeByFile(tokenReport.byFile),
    },
    degradations: normalizeDegradations(record),
    git: {
      diff_mode: asString(git.diff, "off"),
      changed_files_count: asInt(record.changedFilesCount),
      patch_tokens: asInt(record.patchTokens),
    },
  };
}

export function formatManifestReport(report: ManifestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
