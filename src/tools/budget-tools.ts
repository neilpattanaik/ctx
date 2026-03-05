import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SelectionManager } from "../selection";
import {
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokensFromSelection,
  estimateTokensFromText,
  type SelectionEntryText,
} from "../utils/token-estimate";
import { isSubpath, normalizePath, toAbsolute } from "../utils/paths";

const DEFAULT_CODEMAP_ONLY_TOKENS = 120;

export const BUDGET_TOOL_ERROR_CODES = [
  "INVALID_ARGS",
  "NOT_FOUND",
  "READ_DENIED",
  "INTERNAL_ERROR",
] as const;

export type BudgetToolErrorCode = (typeof BUDGET_TOOL_ERROR_CODES)[number];

export class BudgetToolError extends Error {
  code: BudgetToolErrorCode;

  constructor(code: BudgetToolErrorCode, message: string) {
    super(message);
    this.name = "BudgetToolError";
    this.code = code;
  }
}

export interface TokenEstimateArgs {
  text?: string;
  path?: string;
  selection?: boolean;
  chars_per_token?: number;
}

export interface BudgetReportArgs {
  chars_per_token?: number;
}

export interface BudgetValidationResultOk {
  ok: true;
}

export interface BudgetValidationResultErr {
  ok: false;
  message: string;
}

export type BudgetValidationResult =
  | BudgetValidationResultOk
  | BudgetValidationResultErr;

export interface BudgetToolsContext {
  repoRoot: string;
  selectionManager: SelectionManager;
  budgetTokens: number;
  reserveTokens?: number;
  treeTokens?: number;
  metadataTokens?: number;
  diffTokens?: number;
  charsPerToken?: number;
  codemapOnlyTokens?: number;
  readFileText?: (absolutePath: string) => string;
}

interface SelectionTokenSummary {
  full: { count: number; tokens: number };
  slices: { count: number; tokens: number };
  codemap: { count: number; tokens: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFinitePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function normalizeCharsPerToken(
  argsRatio: number | undefined,
  contextRatio: number | undefined,
): number {
  const resolved = argsRatio ?? contextRatio ?? DEFAULT_CHARS_PER_TOKEN;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new BudgetToolError(
      "INVALID_ARGS",
      "chars_per_token must be a finite number greater than zero",
    );
  }
  return resolved;
}

function resolveReadablePath(pathValue: string, repoRoot: string): string {
  const resolvedRoot = resolve(repoRoot);
  const normalizedPath = normalizePath(pathValue, resolvedRoot);
  const absolutePath = toAbsolute(normalizedPath, resolvedRoot);
  if (!isSubpath(absolutePath, resolvedRoot)) {
    throw new BudgetToolError(
      "READ_DENIED",
      "args.path must be within the repository root",
    );
  }
  return absolutePath;
}

function toSelectionTextEntries(
  context: BudgetToolsContext,
  ratio: number,
): SelectionEntryText[] {
  const entries = context.selectionManager.getAll();
  const readText = context.readFileText ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const cache = new Map<string, string>();
  const codemapTokens = context.codemapOnlyTokens ?? DEFAULT_CODEMAP_ONLY_TOKENS;
  const codemapChars = Math.max(0, Math.ceil(codemapTokens * ratio));

  function getFileText(pathValue: string): string {
    const absolutePath = resolveReadablePath(pathValue, context.repoRoot);
    const cached = cache.get(absolutePath);
    if (cached !== undefined) {
      return cached;
    }
    let content: string;
    try {
      content = readText(absolutePath);
    } catch {
      throw new BudgetToolError("NOT_FOUND", `File does not exist: ${pathValue}`);
    }
    cache.set(absolutePath, content);
    return content;
  }

  const selectionEntries: SelectionEntryText[] = [];
  for (const entry of entries) {
    if (entry.mode === "codemap_only") {
      selectionEntries.push({
        mode: "codemap_only",
        text: "x".repeat(codemapChars),
      });
      continue;
    }

    const fileText = getFileText(entry.path);
    if (entry.mode === "full") {
      selectionEntries.push({
        mode: "full",
        text: fileText,
      });
      continue;
    }

    const lines = fileText.replace(/\r\n/g, "\n").split("\n");
    const slices = entry.slices.map((slice) => {
      const startIndex = Math.max(0, slice.startLine - 1);
      const endIndex = Math.max(startIndex, slice.endLine);
      const snippet = lines.slice(startIndex, endIndex).join("\n");
      return { text: snippet };
    });
    selectionEntries.push({
      mode: "slices",
      slices,
    });
  }

  return selectionEntries;
}

function summarizeSelectionTokens(
  context: BudgetToolsContext,
  ratio: number,
): SelectionTokenSummary {
  const entries = context.selectionManager.getAll();
  const readText = context.readFileText ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const cache = new Map<string, string>();
  const summary: SelectionTokenSummary = {
    full: { count: 0, tokens: 0 },
    slices: { count: 0, tokens: 0 },
    codemap: { count: 0, tokens: 0 },
  };
  const codemapTokens = context.codemapOnlyTokens ?? DEFAULT_CODEMAP_ONLY_TOKENS;

  function getFileText(pathValue: string): string {
    const absolutePath = resolveReadablePath(pathValue, context.repoRoot);
    const cached = cache.get(absolutePath);
    if (cached !== undefined) {
      return cached;
    }
    let content: string;
    try {
      content = readText(absolutePath);
    } catch {
      throw new BudgetToolError("NOT_FOUND", `File does not exist: ${pathValue}`);
    }
    cache.set(absolutePath, content);
    return content;
  }

  for (const entry of entries) {
    if (entry.mode === "codemap_only") {
      summary.codemap.count += 1;
      summary.codemap.tokens += codemapTokens;
      continue;
    }

    const fileText = getFileText(entry.path);
    if (entry.mode === "full") {
      summary.full.count += 1;
      summary.full.tokens += estimateTokensFromText(fileText, { charsPerToken: ratio });
      continue;
    }

    summary.slices.count += 1;
    const lines = fileText.replace(/\r\n/g, "\n").split("\n");
    for (const slice of entry.slices) {
      const startIndex = Math.max(0, slice.startLine - 1);
      const endIndex = Math.max(startIndex, slice.endLine);
      const snippet = lines.slice(startIndex, endIndex).join("\n");
      summary.slices.tokens += estimateTokensFromText(snippet, { charsPerToken: ratio });
    }
  }

  return summary;
}

export function validateTokenEstimateArgs(args: unknown): BudgetValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  const hasText = args.text !== undefined;
  const hasPath = args.path !== undefined;
  const hasSelection = args.selection !== undefined;
  const selectedInputCount =
    Number(hasText) + Number(hasPath) + Number(args.selection === true);

  if (hasText && (typeof args.text !== "string" || args.text.length === 0)) {
    return { ok: false, message: "args.text must be a non-empty string when provided" };
  }

  if (hasPath && (typeof args.path !== "string" || args.path.trim().length === 0)) {
    return { ok: false, message: "args.path must be a non-empty string when provided" };
  }

  if (hasSelection && args.selection !== true) {
    return { ok: false, message: "args.selection must be true when provided" };
  }

  if (selectedInputCount !== 1) {
    return {
      ok: false,
      message: "Provide exactly one of args.text, args.path, or args.selection=true",
    };
  }

  if (
    args.chars_per_token !== undefined &&
    readFinitePositiveNumber(args.chars_per_token) === null
  ) {
    return { ok: false, message: "args.chars_per_token must be a finite number > 0" };
  }

  return { ok: true };
}

export function validateBudgetReportArgs(args: unknown): BudgetValidationResult {
  if (args === undefined) {
    return { ok: true };
  }
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object when provided" };
  }
  if (
    args.chars_per_token !== undefined &&
    readFinitePositiveNumber(args.chars_per_token) === null
  ) {
    return { ok: false, message: "args.chars_per_token must be a finite number > 0" };
  }
  const allowedKeys = new Set(["chars_per_token"]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `Unknown argument: ${key}` };
    }
  }
  return { ok: true };
}

export function executeTokenEstimate(
  args: TokenEstimateArgs,
  context: BudgetToolsContext,
): {
  tokens: number;
  method: "char_ratio";
  ratio: number;
  source: "text" | "path" | "selection";
} {
  const ratio = normalizeCharsPerToken(args.chars_per_token, context.charsPerToken);

  if (args.text !== undefined) {
    return {
      tokens: estimateTokensFromText(args.text, { charsPerToken: ratio }),
      method: "char_ratio",
      ratio,
      source: "text",
    };
  }

  if (args.path !== undefined) {
    const readText = context.readFileText ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
    const absolutePath = resolveReadablePath(args.path, context.repoRoot);
    let content: string;
    try {
      content = readText(absolutePath);
    } catch {
      throw new BudgetToolError("NOT_FOUND", `File does not exist: ${args.path}`);
    }
    return {
      tokens: estimateTokensFromText(content, { charsPerToken: ratio }),
      method: "char_ratio",
      ratio,
      source: "path",
    };
  }

  if (args.selection === true) {
    const selectionEntries = toSelectionTextEntries(context, ratio);
    return {
      tokens: estimateTokensFromSelection(selectionEntries, { charsPerToken: ratio }),
      method: "char_ratio",
      ratio,
      source: "selection",
    };
  }

  throw new BudgetToolError(
    "INVALID_ARGS",
    "Provide exactly one of text, path, or selection=true",
  );
}

export function executeBudgetReport(
  args: BudgetReportArgs | undefined,
  context: BudgetToolsContext,
): {
  budget: number;
  estimated_total: number;
  remaining: number;
  breakdown: {
    files_full: { count: number; tokens: number };
    files_slices: { count: number; tokens: number };
    codemaps: { count: number; tokens: number };
    tree: { tokens: number };
    metadata: { tokens: number };
    diff: { tokens: number };
  };
  constraints: {
    max_files: { limit: number; used: number };
    max_full_files: { limit: number; used: number };
  };
} {
  const ratio = normalizeCharsPerToken(args?.chars_per_token, context.charsPerToken);
  const selectionSummary = context.selectionManager.toSummary();
  const manifest = context.selectionManager.toManifest();
  const selectionTokens = summarizeSelectionTokens(context, ratio);
  const treeTokens = Math.max(0, Math.floor(context.treeTokens ?? 0));
  const metadataTokens = Math.max(0, Math.floor(context.metadataTokens ?? 0));
  const diffTokens = Math.max(0, Math.floor(context.diffTokens ?? 0));
  const budget = Math.max(0, Math.floor(context.budgetTokens));
  const reserve = Math.max(0, Math.floor(context.reserveTokens ?? 0));
  const estimatedTotal =
    selectionTokens.full.tokens +
    selectionTokens.slices.tokens +
    selectionTokens.codemap.tokens +
    treeTokens +
    metadataTokens +
    diffTokens;
  const effectiveBudget = Math.max(0, budget - reserve);

  return {
    budget: effectiveBudget,
    estimated_total: estimatedTotal,
    remaining: effectiveBudget - estimatedTotal,
    breakdown: {
      files_full: {
        count: selectionTokens.full.count,
        tokens: selectionTokens.full.tokens,
      },
      files_slices: {
        count: selectionTokens.slices.count,
        tokens: selectionTokens.slices.tokens,
      },
      codemaps: {
        count: selectionTokens.codemap.count,
        tokens: selectionTokens.codemap.tokens,
      },
      tree: { tokens: treeTokens },
      metadata: { tokens: metadataTokens },
      diff: { tokens: diffTokens },
    },
    constraints: {
      max_files: {
        limit: manifest.constraints.maxFiles,
        used: selectionSummary.totalFiles,
      },
      max_full_files: {
        limit: manifest.constraints.maxFullFiles,
        used: selectionSummary.byMode.full,
      },
    },
  };
}
