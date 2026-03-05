import type { DiscoveryResult, SelectionEntry, SliceRange } from "../types";

const CTX_FINAL_BLOCK_PATTERN = /```ctx_final\s*([\s\S]*?)```/g;

type UnknownRecord = Record<string, unknown>;

const VALID_SELECTION_MODES = new Set(["full", "slices", "codemap_only"]);
const VALID_SELECTION_PRIORITIES = new Set(["core", "support", "ref"]);

export interface CtxFinalValidationIssue {
  field: string;
  message: string;
}

export interface CtxFinalValidationOptions {
  availablePaths: readonly string[];
  turnsRemaining: number;
}

export interface CtxFinalValidationFailure {
  ok: false;
  issues: CtxFinalValidationIssue[];
  action: "retry" | "fallback";
  message: string;
  malformedOutput: unknown;
}

export interface CtxFinalValidationSuccess {
  ok: true;
  discovery: DiscoveryResult;
}

export type CtxFinalValidationResult =
  | CtxFinalValidationSuccess
  | CtxFinalValidationFailure;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(
  value: unknown,
  field: string,
  issues: CtxFinalValidationIssue[],
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ field, message: "must be a non-empty string" });
    return null;
  }
  return value;
}

function readPositiveInteger(
  value: unknown,
  field: string,
  issues: CtxFinalValidationIssue[],
): number | null {
  if (!Number.isInteger(value) || (value as number) < 1) {
    issues.push({ field, message: "must be a positive integer" });
    return null;
  }
  return value as number;
}

function buildFailure(
  issues: CtxFinalValidationIssue[],
  options: CtxFinalValidationOptions,
  malformedOutput: unknown,
): CtxFinalValidationFailure {
  const action = options.turnsRemaining > 0 ? "retry" : "fallback";
  return {
    ok: false,
    issues,
    action,
    message:
      action === "retry"
        ? "ctx_final validation failed; fix the listed fields and retry."
        : "ctx_final validation failed with no turns remaining; use deterministic fallback discovery.",
    malformedOutput,
  };
}

function normalizeSlices(
  value: unknown,
  pathPrefix: string,
  fallbackRationale: string,
  issues: CtxFinalValidationIssue[],
): SliceRange[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ field: pathPrefix, message: "must be a non-empty array" });
    return null;
  }

  const slices: SliceRange[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${pathPrefix}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ field: itemPath, message: "must be an object" });
      continue;
    }

    const startLine = readPositiveInteger(
      item.start_line,
      `${itemPath}.start_line`,
      issues,
    );
    const endLine = readPositiveInteger(
      item.end_line,
      `${itemPath}.end_line`,
      issues,
    );
    const description = readNonEmptyString(
      item.description,
      `${itemPath}.description`,
      issues,
    );

    if (
      startLine !== null &&
      endLine !== null &&
      endLine < startLine
    ) {
      issues.push({
        field: `${itemPath}.end_line`,
        message: "must be greater than or equal to start_line",
      });
    }

    if (startLine === null || endLine === null || description === null) {
      continue;
    }

    slices.push({
      startLine,
      endLine,
      description,
      rationale:
        typeof item.rationale === "string" && item.rationale.trim().length > 0
          ? item.rationale
          : fallbackRationale,
    });
  }

  return slices;
}

export function parseCtxFinalBlocks(text: string): {
  payloads: unknown[];
  errors: CtxFinalValidationIssue[];
} {
  const payloads: unknown[] = [];
  const errors: CtxFinalValidationIssue[] = [];

  let index = 0;
  for (const match of text.matchAll(CTX_FINAL_BLOCK_PATTERN)) {
    index += 1;
    const rawBlock = match[1]?.trim() ?? "";
    try {
      payloads.push(JSON.parse(rawBlock));
    } catch (error) {
      errors.push({
        field: `ctx_final[${index}]`,
        message:
          error instanceof Error
            ? `invalid JSON: ${error.message}`
            : "invalid JSON",
      });
    }
  }

  return { payloads, errors };
}

export function validateCtxFinalPayload(
  payload: unknown,
  options: CtxFinalValidationOptions,
): CtxFinalValidationResult {
  const issues: CtxFinalValidationIssue[] = [];
  if (!isRecord(payload)) {
    return buildFailure(
      [{ field: "ctx_final", message: "must be an object" }],
      options,
      payload,
    );
  }

  const openQuestionsRaw = payload.open_questions;
  const handoffSummaryRaw = payload.handoff_summary;
  const selectionRaw = payload.selection;

  if (!Array.isArray(openQuestionsRaw)) {
    issues.push({ field: "open_questions", message: "must be an array" });
  }
  if (!isRecord(handoffSummaryRaw)) {
    issues.push({ field: "handoff_summary", message: "must be an object" });
  }
  if (!Array.isArray(selectionRaw)) {
    issues.push({ field: "selection", message: "must be an array" });
  }

  if (issues.length > 0) {
    return buildFailure(issues, options, payload);
  }

  const openQuestions = openQuestionsRaw as unknown[];
  const handoffSummary = handoffSummaryRaw as UnknownRecord;
  const selection = selectionRaw as unknown[];

  const normalizedOpenQuestions: DiscoveryResult["openQuestions"] = [];
  for (let index = 0; index < openQuestions.length; index += 1) {
    const item = openQuestions[index];
    const itemPath = `open_questions[${index}]`;
    if (!isRecord(item)) {
      issues.push({ field: itemPath, message: "must be an object" });
      continue;
    }

    const question = readNonEmptyString(item.question, `${itemPath}.question`, issues);
    const whyItMatters = readNonEmptyString(
      item.why_it_matters,
      `${itemPath}.why_it_matters`,
      issues,
    );
    const defaultAssumption = readNonEmptyString(
      item.default_assumption,
      `${itemPath}.default_assumption`,
      issues,
    );

    if (
      question === null ||
      whyItMatters === null ||
      defaultAssumption === null
    ) {
      continue;
    }

    normalizedOpenQuestions.push({
      question,
      whyItMatters,
      defaultAssumption,
    });
  }

  function normalizePathNotes(
    value: unknown,
    field: string,
  ): Array<{ path: string; notes: string }> {
    const notes: Array<{ path: string; notes: string }> = [];
    if (!Array.isArray(value)) {
      issues.push({ field, message: "must be an array" });
      return notes;
    }

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const itemPath = `${field}[${index}]`;
      if (!isRecord(item)) {
        issues.push({ field: itemPath, message: "must be an object" });
        continue;
      }
      const path = readNonEmptyString(item.path, `${itemPath}.path`, issues);
      const notesText = readNonEmptyString(item.notes, `${itemPath}.notes`, issues);
      if (path === null || notesText === null) {
        continue;
      }
      notes.push({ path, notes: notesText });
    }

    return notes;
  }

  function normalizeDataFlowNotes(
    value: unknown,
    field: string,
  ): Array<{ name: string; notes: string }> {
    const notes: Array<{ name: string; notes: string }> = [];
    if (!Array.isArray(value)) {
      issues.push({ field, message: "must be an array" });
      return notes;
    }

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const itemPath = `${field}[${index}]`;
      if (!isRecord(item)) {
        issues.push({ field: itemPath, message: "must be an object" });
        continue;
      }
      const name = readNonEmptyString(item.name, `${itemPath}.name`, issues);
      const notesText = readNonEmptyString(item.notes, `${itemPath}.notes`, issues);
      if (name === null || notesText === null) {
        continue;
      }
      notes.push({ name, notes: notesText });
    }

    return notes;
  }

  function normalizeConfigKnobs(
    value: unknown,
    field: string,
  ): Array<{ key: string; where: string; notes: string }> {
    const knobs: Array<{ key: string; where: string; notes: string }> = [];
    if (!Array.isArray(value)) {
      issues.push({ field, message: "must be an array" });
      return knobs;
    }

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const itemPath = `${field}[${index}]`;
      if (!isRecord(item)) {
        issues.push({ field: itemPath, message: "must be an object" });
        continue;
      }
      const key = readNonEmptyString(item.key, `${itemPath}.key`, issues);
      const where = readNonEmptyString(item.where, `${itemPath}.where`, issues);
      const notesText = readNonEmptyString(item.notes, `${itemPath}.notes`, issues);
      if (key === null || where === null || notesText === null) {
        continue;
      }
      knobs.push({ key, where, notes: notesText });
    }

    return knobs;
  }

  const normalizedHandoffSummary: DiscoveryResult["handoffSummary"] = {
    entrypoints: normalizePathNotes(handoffSummary.entrypoints, "handoff_summary.entrypoints"),
    keyModules: normalizePathNotes(handoffSummary.key_modules, "handoff_summary.key_modules"),
    dataFlows: normalizeDataFlowNotes(handoffSummary.data_flows, "handoff_summary.data_flows"),
    configKnobs: normalizeConfigKnobs(handoffSummary.config_knobs, "handoff_summary.config_knobs"),
    tests: normalizePathNotes(handoffSummary.tests, "handoff_summary.tests"),
  };

  const availablePathSet = new Set(options.availablePaths);
  const normalizedSelection: SelectionEntry[] = [];
  for (let index = 0; index < selection.length; index += 1) {
    const item = selection[index];
    const itemPath = `selection[${index}]`;
    if (!isRecord(item)) {
      issues.push({ field: itemPath, message: "must be an object" });
      continue;
    }

    const path = readNonEmptyString(item.path, `${itemPath}.path`, issues);
    const mode = readNonEmptyString(item.mode, `${itemPath}.mode`, issues);
    const priority = readNonEmptyString(item.priority, `${itemPath}.priority`, issues);
    const rationale = readNonEmptyString(
      item.rationale,
      `${itemPath}.rationale`,
      issues,
    );

    if (path === null || mode === null || priority === null || rationale === null) {
      continue;
    }

    if (!availablePathSet.has(path)) {
      issues.push({
        field: `${itemPath}.path`,
        message: `path does not exist in repo: ${path}`,
      });
    }

    if (!VALID_SELECTION_MODES.has(mode)) {
      issues.push({
        field: `${itemPath}.mode`,
        message: "must be one of: full, slices, codemap_only",
      });
      continue;
    }

    if (!VALID_SELECTION_PRIORITIES.has(priority)) {
      issues.push({
        field: `${itemPath}.priority`,
        message: "must be one of: core, support, ref",
      });
      continue;
    }

    if (mode === "slices") {
      const slices = normalizeSlices(
        item.slices,
        `${itemPath}.slices`,
        rationale,
        issues,
      );
      if (slices === null) {
        continue;
      }

      normalizedSelection.push({
        path,
        mode: "slices",
        priority: priority as SelectionEntry["priority"],
        rationale,
        slices,
      });
      continue;
    }

    normalizedSelection.push({
      path,
      mode: mode as "full" | "codemap_only",
      priority: priority as SelectionEntry["priority"],
      rationale,
    });
  }

  if (issues.length > 0) {
    return buildFailure(issues, options, payload);
  }

  return {
    ok: true,
    discovery: {
      openQuestions: normalizedOpenQuestions,
      handoffSummary: normalizedHandoffSummary,
      selection: normalizedSelection,
    },
  };
}

export function validateCtxFinalFromText(
  text: string,
  options: CtxFinalValidationOptions,
): CtxFinalValidationResult {
  const parsed = parseCtxFinalBlocks(text);
  if (parsed.errors.length > 0) {
    return buildFailure(parsed.errors, options, text);
  }
  if (parsed.payloads.length === 0) {
    return buildFailure(
      [{ field: "ctx_final", message: "missing ctx_final block" }],
      options,
      text,
    );
  }

  return validateCtxFinalPayload(parsed.payloads[0], options);
}
