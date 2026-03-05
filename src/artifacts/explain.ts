import { resolve } from "node:path";
import type { SelectionEntry, TokenDegradation } from "../types";

type ExplainSelectionEntry = SelectionEntry & {
  source?: string;
  selectionSource?: string;
  priorityScore?: number;
  priorityBreakdown?: Record<string, number>;
  priorityComponents?: Record<string, number>;
};

type ExplainDegradationEntry =
  | TokenDegradation
  | {
      step?: string;
      action?: string;
      reason?: string;
      delta?: number;
      tokensSaved?: number;
      targetPath?: string;
      fromMode?: string;
      toMode?: string;
    };

export interface ExplainRunRecord {
  runId: string;
  task: string;
  config: {
    discovery?: {
      discover?: string;
      maxTurns?: number;
    };
    output?: {
      runsDir?: string;
    };
  };
  selection: ExplainSelectionEntry[];
  tokenReport: {
    budget: number;
    estimated: number;
    bySection: Record<string, number>;
    byFile: Record<string, number>;
    degradations: ExplainDegradationEntry[];
    initialEstimate?: number;
    finalEstimate?: number;
  };
  timing: {
    phaseDurationsMs: Record<string, number>;
  };
  discoveryBackend?: string;
  discoveryDurationMs?: number;
  discoveryTurns?: number;
  dropped?: Array<{ path: string; reason: string }>;
}

export interface ExplainIo {
  readFile(path: string): string;
  readLink(path: string): string;
}

export interface LoadedExplainRun {
  runId: string;
  runRecordPath: string;
  record: ExplainRunRecord;
}

interface ParsedDegradation {
  step: string;
  path?: string;
  from?: string;
  to?: string;
  delta: number;
  reason: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function ensureValidRunId(value: string, sourceLabel: string): string {
  const runId = value.trim();
  if (runId.length === 0) {
    throw new Error(`${sourceLabel} is empty`);
  }
  if (runId === "." || runId === ".." || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`${sourceLabel} is invalid: '${value}'`);
  }
  return runId;
}

function parseRunIdFromPointer(pointer: string): string {
  const pointerText = pointer.trim();
  if (pointerText.length === 0) {
    throw new Error("latest run pointer is empty");
  }

  const firstToken = pointerText.split(/\s+/)[0] ?? "";
  const normalized = firstToken.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const runId = segments[segments.length - 1];
  if (!runId) {
    throw new Error("latest run pointer is empty");
  }
  return ensureValidRunId(runId, "latest run pointer");
}

function resolveRunId(target: string, runsRoot: string, io: ExplainIo): string {
  if (target !== "last") {
    return ensureValidRunId(target, "run target");
  }

  const latestPath = resolve(runsRoot, "latest");
  const latestFallbackPath = resolve(runsRoot, "latest-run-id");
  try {
    return parseRunIdFromPointer(io.readFile(latestFallbackPath));
  } catch (readFallbackError) {
    try {
      return parseRunIdFromPointer(io.readLink(latestPath));
    } catch (readLinkError) {
      try {
        return parseRunIdFromPointer(io.readFile(latestPath));
      } catch (readFileError) {
        const readFallbackMessage =
          readFallbackError instanceof Error ? readFallbackError.message : String(readFallbackError);
        const readLinkMessage =
          readLinkError instanceof Error ? readLinkError.message : String(readLinkError);
        const readFileMessage =
          readFileError instanceof Error ? readFileError.message : String(readFileError);
        throw new Error(
          `failed to resolve latest run pointer: latest-run-id read failed (${readFallbackMessage}); readlink '${latestPath}' failed (${readLinkMessage}); legacy latest file read failed (${readFileMessage})`,
        );
      }
    }
  }
}

export function loadRunRecordForExplain(options: {
  repoRoot: string;
  runsDir: string;
  target: string;
  io: ExplainIo;
}): LoadedExplainRun {
  const runsRoot = resolve(options.repoRoot, options.runsDir);
  const runId = resolveRunId(options.target, runsRoot, options.io);
  const runRecordPath = resolve(runsRoot, runId, "run.json");
  const raw = options.io.readFile(runRecordPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid run record JSON at ${runRecordPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid run record at ${runRecordPath}: expected object`);
  }

  return {
    runId,
    runRecordPath,
    record: parsed as ExplainRunRecord,
  };
}

function parseDegradationEntry(entry: ExplainDegradationEntry): ParsedDegradation {
  const step =
    typeof entry === "object" && entry !== null
      ? "step" in entry
        ? typeof entry.step === "string"
          ? entry.step
          : "action" in entry && typeof entry.action === "string"
            ? entry.action
            : "unknown"
        : "action" in entry && typeof entry.action === "string"
          ? entry.action
          : "unknown"
      : "unknown";

  const reason =
    typeof entry === "object" &&
    entry !== null &&
    "reason" in entry &&
    typeof entry.reason === "string"
      ? entry.reason
      : "";
  const deltaCandidate =
    typeof entry === "object" && entry !== null && "delta" in entry
      ? entry.delta
      : typeof entry === "object" && entry !== null && "tokensSaved" in entry
        ? entry.tokensSaved
        : 0;
  const delta =
    typeof deltaCandidate === "number" && Number.isFinite(deltaCandidate)
      ? Math.floor(deltaCandidate)
      : 0;

  if (step === "full_to_slices" || step === "slices_to_codemap_only") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "targetPath" in entry &&
      typeof entry.targetPath === "string"
    ) {
      const from =
        "fromMode" in entry && typeof entry.fromMode === "string" ? entry.fromMode : undefined;
      const to = "toMode" in entry && typeof entry.toMode === "string" ? entry.toMode : undefined;
      return { step, path: entry.targetPath, from, to, delta, reason };
    }

    const match = /^degrade (.+) ([a-z_]+)->([a-z_]+)$/.exec(reason);
    if (match) {
      return { step, path: match[1], from: match[2], to: match[3], delta, reason };
    }
  }

  if (step === "drop_codemap_only") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "targetPath" in entry &&
      typeof entry.targetPath === "string"
    ) {
      return {
        step,
        path: entry.targetPath,
        from:
          "fromMode" in entry && typeof entry.fromMode === "string"
            ? entry.fromMode
            : "codemap_only",
        delta,
        reason,
      };
    }

    const match = /^drop (.+) codemap_only$/.exec(reason);
    if (match) {
      return { step, path: match[1], from: "codemap_only", delta, reason };
    }
  }

  return { step, delta, reason };
}

function getPriorityBreakdown(
  entry: ExplainSelectionEntry,
): Array<{ label: string; value: number }> {
  const raw = entry.priorityBreakdown ?? entry.priorityComponents;
  if (!raw) {
    return [];
  }

  return Object.entries(raw)
    .filter(
      (item): item is [string, number] =>
        typeof item[0] === "string" &&
        item[0].length > 0 &&
        typeof item[1] === "number" &&
        Number.isFinite(item[1]),
    )
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
    );
}

function formatSelectionSection(record: ExplainRunRecord): string[] {
  if (record.selection.length === 0) {
    return ["- none"];
  }

  const parsedDegradations = record.tokenReport.degradations.map((item) =>
    parseDegradationEntry(item),
  );

  const lines: string[] = [];
  for (const entry of record.selection) {
    lines.push(`- ${entry.path}`);
    lines.push(`  mode: ${entry.mode}`);
    lines.push(`  why: ${entry.rationale}`);
    lines.push(`  priority: ${entry.priority}`);

    const source = entry.selectionSource ?? entry.source;
    if (source) {
      lines.push(`  source: ${source}`);
    }

    if (typeof entry.priorityScore === "number" && Number.isFinite(entry.priorityScore)) {
      lines.push(`  priority_score: ${Math.floor(entry.priorityScore)}`);
    }

    const priorityBreakdown = getPriorityBreakdown(entry);
    if (priorityBreakdown.length > 0) {
      lines.push("  priority_breakdown:");
      for (const item of priorityBreakdown) {
        lines.push(`    - ${item.label}: ${Math.floor(item.value)}`);
      }
    }

    const degradations = parsedDegradations.filter((item) => item.path === entry.path);
    for (const degradation of degradations) {
      if (!degradation.from && !degradation.to) {
        continue;
      }
      const from = degradation.from ?? "n/a";
      const to = degradation.to ?? "dropped";
      lines.push(
        `  degradation: ${degradation.step} (${from}->${to}, delta=${degradation.delta})`,
      );
      if (degradation.reason) {
        lines.push(`  degradation_reason: ${degradation.reason}`);
      }
    }
  }
  return lines;
}

function formatDroppedSection(record: ExplainRunRecord): string[] {
  const dropped = [...(record.dropped ?? [])];

  for (const degradation of record.tokenReport.degradations) {
    const parsed = parseDegradationEntry(degradation);
    if (parsed.step !== "drop_codemap_only") {
      continue;
    }
    if (!parsed.path) {
      continue;
    }
    dropped.push({
      path: parsed.path,
      reason: "budget degradation",
    });
  }

  if (dropped.length === 0) {
    return ["- none recorded"];
  }

  const uniqueDropped = new Map<string, string>();
  for (const entry of dropped) {
    if (!uniqueDropped.has(entry.path)) {
      uniqueDropped.set(entry.path, entry.reason);
    }
  }

  return [...uniqueDropped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([path, reason]) => `- ${path}: ${reason}`);
}

function formatTokenBudgetSection(record: ExplainRunRecord): string[] {
  const tokenReport = record.tokenReport;
  const initialEstimate =
    typeof tokenReport.initialEstimate === "number"
      ? tokenReport.initialEstimate
      : tokenReport.estimated;
  const finalEstimate =
    typeof tokenReport.finalEstimate === "number"
      ? tokenReport.finalEstimate
      : tokenReport.estimated;

  const topFiles = Object.entries(tokenReport.byFile ?? {})
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
    )
    .slice(0, 10)
    .map(([path, tokens]) => `  - ${path}: ${tokens}`);

  return [
    `- budget: ${tokenReport.budget}`,
    `- initial_estimate: ${initialEstimate}`,
    `- final_estimate: ${finalEstimate}`,
    "- by_section:",
    ...Object.entries(tokenReport.bySection ?? {})
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([section, tokens]) => `  - ${section}: ${tokens}`),
    "- by_file_top_10:",
    ...(topFiles.length > 0 ? topFiles : ["  - none"]),
  ];
}

function formatDegradationsSection(record: ExplainRunRecord): string[] {
  if (record.tokenReport.degradations.length === 0) {
    return ["- none"];
  }

  return record.tokenReport.degradations.map((entry, index) => {
    const parsed = parseDegradationEntry(entry);
    const details: string[] = [];
    if (parsed.path) {
      details.push(`path=${parsed.path}`);
    }
    if (parsed.from) {
      details.push(`from=${parsed.from}`);
    }
    if (parsed.to) {
      details.push(`to=${parsed.to}`);
    }
    const detailsSuffix = details.length > 0 ? ` [${details.join(", ")}]` : "";
    const reason = parsed.reason.length > 0 ? parsed.reason : "(no reason)";
    return `- ${index + 1}. ${parsed.step}${detailsSuffix}: ${reason} (delta=${parsed.delta})`;
  });
}

export function formatExplainReport(input: LoadedExplainRun): string {
  const record = input.record;
  const backend = record.discoveryBackend ?? record.config.discovery?.discover ?? "unknown";
  const turns = record.discoveryTurns ?? record.config.discovery?.maxTurns ?? "n/a";
  const durationMs =
    record.discoveryDurationMs ?? record.timing.phaseDurationsMs.discovery ?? "n/a";

  const sections: string[] = [
    `# ctx explain: ${input.runId}`,
    "",
    "## TASK",
    record.task ?? "(missing task)",
    "",
    "## DISCOVERY",
    `- backend: ${backend}`,
    `- turns: ${turns}`,
    `- duration_ms: ${durationMs}`,
    "",
    "## SELECTION",
    ...formatSelectionSection(record),
    "",
    "## DROPPED",
    ...formatDroppedSection(record),
    "",
    "## TOKEN BUDGET",
    ...formatTokenBudgetSection(record),
    "",
    "## DEGRADATIONS",
    ...formatDegradationsSection(record),
  ];

  return `${sections.join("\n")}\n`;
}
