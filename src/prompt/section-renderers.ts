import type {
  CodemapEntry,
  DiscoveryHandoffSummary,
  OpenQuestion,
  SelectionEntry,
  SelectionMode,
  SelectionPriority,
  SliceRange,
  TokenReport,
} from "../types";
import type { PromptFormatSection } from "./output-format";

export interface MetadataField {
  key: string;
  value: string | number | boolean | null | undefined;
}

export interface RepoOverviewSectionInput {
  buildHints?: readonly string[];
  languageStats?: Record<string, number>;
  gitStatusSummary?: string;
  indexStatus?: string;
  ignoreSummary?: {
    gitignorePatterns: number;
    configIgnores: number;
  };
  notes?: readonly string[];
}

export interface FilesSectionSlice extends SliceRange {
  content?: string;
}

export interface FilesSectionEntry {
  path: string;
  mode: SelectionMode;
  priority: SelectionPriority;
  rationale: string;
  content?: string;
  slices?: readonly FilesSectionSlice[];
}

export interface ManifestSectionEntry extends SelectionEntry {
  priorityScore?: number;
}

export interface RenderPromptSectionsInput {
  metadata: readonly MetadataField[];
  task: string;
  openQuestions?: readonly OpenQuestion[];
  repoOverview?: RepoOverviewSectionInput;
  tree?: string;
  handoffSummary?: DiscoveryHandoffSummary;
  codemaps?: readonly CodemapEntry[];
  files?: readonly FilesSectionEntry[];
  gitDiff?: string;
  tokenReport?: TokenReport;
  manifest?: readonly ManifestSectionEntry[];
  lineNumbers?: boolean;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function asLineNumberText(text: string, startLine = 1): string {
  const lines = normalizeLineEndings(text).split("\n");
  return lines
    .map((line, index) => `${String(startLine + index).padStart(4, "0")}| ${line}`)
    .join("\n");
}

function toList(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "- none";
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

function sanitizeMetadataValue(value: MetadataField["value"]): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function normalizeManifestEntries(
  entries: readonly ManifestSectionEntry[],
): ManifestSectionEntry[] {
  return [...entries].sort((left, right) => {
    const leftScore =
      typeof left.priorityScore === "number" && Number.isFinite(left.priorityScore)
        ? Math.floor(left.priorityScore)
        : Number.NEGATIVE_INFINITY;
    const rightScore =
      typeof right.priorityScore === "number" && Number.isFinite(right.priorityScore)
        ? Math.floor(right.priorityScore)
        : Number.NEGATIVE_INFINITY;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.path.localeCompare(right.path);
  });
}

function normalizeLanguageStats(
  languageStats: Record<string, number> | undefined,
): Array<{ name: string; count: number }> {
  if (!languageStats) {
    return [];
  }

  return Object.entries(languageStats)
    .filter(
      (entry): entry is [string, number] =>
        entry[0].trim().length > 0 &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] >= 0,
    )
    .map(([name, count]) => ({ name, count: Math.floor(count) }))
    .sort((left, right) =>
      right.count === left.count
        ? left.name.localeCompare(right.name)
        : right.count - left.count,
    );
}

export function renderMetadataSection(
  fields: readonly MetadataField[],
): string {
  if (fields.length === 0) {
    return "- none";
  }

  return fields
    .filter((field) => field.key.trim().length > 0)
    .map((field) => `${field.key}: ${sanitizeMetadataValue(field.value)}`)
    .join("\n");
}

export function renderTaskSection(task: string): string {
  return task.length > 0 ? task : "(no task provided)";
}

export function renderOpenQuestionsSection(
  openQuestions: readonly OpenQuestion[],
): string {
  if (openQuestions.length === 0) {
    return "- none";
  }

  return openQuestions
    .map(
      (question, index) =>
        [
          `${index + 1}. ${question.question}`,
          `   why: ${question.whyItMatters}`,
          `   default: ${question.defaultAssumption}`,
        ].join("\n"),
    )
    .join("\n");
}

export function renderRepoOverviewSection(
  input: RepoOverviewSectionInput,
): string {
  const lines: string[] = [];
  const buildHints = [...new Set(input.buildHints ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
  const languageStats = normalizeLanguageStats(input.languageStats);

  lines.push("build_hints:");
  lines.push(toList(buildHints));

  lines.push("language_stats:");
  lines.push(
    toList(languageStats.map((entry) => `${entry.name}: ${entry.count}`)),
  );

  if (input.indexStatus) {
    lines.push(`index_status: ${input.indexStatus}`);
  }

  if (input.ignoreSummary) {
    lines.push(
      `ignore_summary: gitignore_patterns=${input.ignoreSummary.gitignorePatterns}, config_ignores=${input.ignoreSummary.configIgnores}`,
    );
  }

  if (input.gitStatusSummary) {
    lines.push("git_status:");
    lines.push(input.gitStatusSummary);
  }

  const notes = [...new Set(input.notes ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
  if (notes.length > 0) {
    lines.push("notes:");
    lines.push(toList(notes));
  }

  return lines.join("\n");
}

export function renderTreeSection(tree: string): string {
  return tree.trim().length > 0 ? tree : "- none";
}

function renderPathNotes(
  notes: readonly { path: string; notes: string }[],
): string {
  if (notes.length === 0) {
    return "- none";
  }
  return notes.map((note) => `- ${note.path}: ${note.notes}`).join("\n");
}

function renderDataFlowNotes(
  notes: readonly { name: string; notes: string }[],
): string {
  if (notes.length === 0) {
    return "- none";
  }
  return notes.map((note) => `- ${note.name}: ${note.notes}`).join("\n");
}

function renderConfigKnobNotes(
  notes: readonly { key: string; where: string; notes: string }[],
): string {
  if (notes.length === 0) {
    return "- none";
  }
  return notes
    .map((note) => `- ${note.key} @ ${note.where}: ${note.notes}`)
    .join("\n");
}

export function renderHandoffSummarySection(
  summary: DiscoveryHandoffSummary,
): string {
  return [
    "entrypoints:",
    renderPathNotes(summary.entrypoints),
    "key_modules:",
    renderPathNotes(summary.keyModules),
    "data_flows:",
    renderDataFlowNotes(summary.dataFlows),
    "config_knobs:",
    renderConfigKnobNotes(summary.configKnobs),
    "tests:",
    renderPathNotes(summary.tests),
  ].join("\n");
}

export function renderCodemapsSection(
  codemaps: readonly CodemapEntry[],
): string {
  if (codemaps.length === 0) {
    return "- none";
  }

  const ordered = [...codemaps].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const lines: string[] = [];
  for (const codemap of ordered) {
    lines.push(`--- ${codemap.path} (${codemap.language}, ${codemap.lines} lines) ---`);
    if (codemap.symbols.length === 0) {
      lines.push("- no symbols");
      continue;
    }
    for (const symbol of codemap.symbols) {
      const endPart =
        typeof symbol.endLine === "number" ? `-L${symbol.endLine}` : "";
      lines.push(
        `- ${symbol.kind} ${symbol.signature} (L${symbol.line}${endPart})`,
      );
    }
  }

  return lines.join("\n");
}

function renderSliceContent(
  slice: FilesSectionSlice,
  lineNumbers: boolean,
): string {
  const content = slice.content ?? "";
  if (content.length === 0) {
    return "(slice content unavailable)";
  }
  return lineNumbers
    ? asLineNumberText(content, slice.startLine)
    : normalizeLineEndings(content);
}

export function renderFilesSection(
  files: readonly FilesSectionEntry[],
  options: { lineNumbers: boolean },
): string {
  if (files.length === 0) {
    return "- none";
  }

  const ordered = [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const lines: string[] = [];
  for (const file of ordered) {
    if (file.mode === "full") {
      lines.push(
        `--- ${file.path} (full, priority=${file.priority}) ---`,
      );
      lines.push(`rationale: ${file.rationale}`);
      const content = file.content ?? "";
      lines.push(
        options.lineNumbers ? asLineNumberText(content, 1) : normalizeLineEndings(content),
      );
      continue;
    }

    if (file.mode === "slices") {
      const slices = [...(file.slices ?? [])].sort((left, right) =>
        left.startLine === right.startLine
          ? left.endLine - right.endLine
          : left.startLine - right.startLine,
      );
      if (slices.length === 0) {
        lines.push(`--- ${file.path} (slices, priority=${file.priority}) ---`);
        lines.push(`rationale: ${file.rationale}`);
        lines.push("(no slices)");
        continue;
      }

      for (const slice of slices) {
        lines.push(
          `--- ${file.path} L${slice.startLine}-L${slice.endLine} (${slice.description}) ---`,
        );
        lines.push(`rationale: ${slice.rationale}`);
        lines.push(renderSliceContent(slice, options.lineNumbers));
      }
      continue;
    }

    lines.push(`--- ${file.path} (codemap_only, priority=${file.priority}) ---`);
    lines.push(`rationale: ${file.rationale}`);
    lines.push("(see CODEMAPS section)");
  }

  return lines.join("\n");
}

export function renderGitDiffSection(gitDiff: string): string {
  return gitDiff.trim().length > 0 ? gitDiff : "- none";
}

export function renderTokenReportSection(tokenReport: TokenReport): string {
  const bySection = Object.entries(tokenReport.bySection ?? {}).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  const byFile = Object.entries(tokenReport.byFile ?? {}).sort((left, right) =>
    right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
  );

  const lines: string[] = [
    `budget: ${tokenReport.budget}`,
    `estimated: ${tokenReport.estimated}`,
    "by_section:",
    ...(bySection.length > 0
      ? bySection.map(([name, value]) => `- ${name}: ${value}`)
      : ["- none"]),
    "by_file:",
    ...(byFile.length > 0
      ? byFile.map(([name, value]) => `- ${name}: ${value}`)
      : ["- none"]),
    "degradations:",
    ...(tokenReport.degradations.length > 0
      ? tokenReport.degradations.map(
          (degradation) =>
            `- ${degradation.step}: ${degradation.reason} (delta=${degradation.delta})`,
        )
      : ["- none"]),
  ];

  return lines.join("\n");
}

export function renderManifestSection(
  entries: readonly ManifestSectionEntry[],
): string {
  if (entries.length === 0) {
    return "- none";
  }

  const ordered = normalizeManifestEntries(entries);
  const lines: string[] = [];
  for (const entry of ordered) {
    const priorityScore =
      typeof entry.priorityScore === "number" && Number.isFinite(entry.priorityScore)
        ? `, score=${Math.floor(entry.priorityScore)}`
        : "";
    lines.push(
      `- ${entry.path} [mode=${entry.mode}, priority=${entry.priority}${priorityScore}]`,
    );
    lines.push(`  rationale: ${entry.rationale}`);
    if (entry.mode === "slices") {
      const sliceText = entry.slices
        .map((slice) => `L${slice.startLine}-L${slice.endLine} (${slice.description})`)
        .join("; ");
      lines.push(`  slices: ${sliceText}`);
    }
  }

  return lines.join("\n");
}

export function renderPromptSections(
  input: RenderPromptSectionsInput,
): PromptFormatSection[] {
  return [
    { key: "metadata", title: "Metadata", body: renderMetadataSection(input.metadata) },
    { key: "task", title: "Task", body: renderTaskSection(input.task) },
    {
      key: "open_questions",
      title: "Open Questions",
      body: renderOpenQuestionsSection(input.openQuestions ?? []),
    },
    {
      key: "repo_overview",
      title: "Repo Overview",
      body: renderRepoOverviewSection(input.repoOverview ?? {}),
    },
    { key: "tree", title: "Tree", body: renderTreeSection(input.tree ?? "") },
    {
      key: "handoff_summary",
      title: "Handoff Summary",
      body: input.handoffSummary
        ? renderHandoffSummarySection(input.handoffSummary)
        : "- none",
    },
    {
      key: "codemaps",
      title: "Codemaps",
      body: renderCodemapsSection(input.codemaps ?? []),
    },
    {
      key: "files",
      title: "Files",
      body: renderFilesSection(input.files ?? [], {
        lineNumbers: input.lineNumbers ?? true,
      }),
    },
    { key: "git_diff", title: "Git Diff", body: renderGitDiffSection(input.gitDiff ?? "") },
    {
      key: "token_report",
      title: "Token Report",
      body: input.tokenReport ? renderTokenReportSection(input.tokenReport) : "- none",
    },
    {
      key: "manifest",
      title: "Manifest",
      body: renderManifestSection(input.manifest ?? []),
    },
  ];
}
