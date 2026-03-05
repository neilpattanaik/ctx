import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TreeSitterCodemapParser,
  detectCodemapLanguage,
  extractSymbolsFromTree,
} from "../codemap";
import { isSubpath, normalizePath, toAbsolute } from "../utils/paths";
import {
  enforceCodemapTruncation,
  type CodemapResultItem,
  type CodemapResultPayload,
} from "./truncation";

const CODEMAP_DETAILS = ["summary", "complete"] as const;

export type CodemapDetail = (typeof CODEMAP_DETAILS)[number];

export interface CodemapArgs {
  paths: string[];
  detail?: CodemapDetail;
  max_symbols?: number;
  max_results?: number;
}

export interface CodemapLookupOptions {
  detail: CodemapDetail;
  maxSymbols?: number;
  maxResults?: number;
}

export interface CodemapToolsContext {
  repoRoot: string;
  repoFiles: readonly string[];
  codemapLookup?: (
    paths: readonly string[],
    options: CodemapLookupOptions,
  ) => Promise<CodemapResultItem[]> | CodemapResultItem[];
  readFileText?: (absolutePath: string) => Promise<string>;
  parserFactory?: (repoRoot: string) => Promise<TreeSitterCodemapParser>;
}

export const CODEMAP_TOOL_ERROR_CODES = [
  "INVALID_ARGS",
  "NOT_FOUND",
  "READ_DENIED",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type CodemapToolErrorCode = (typeof CODEMAP_TOOL_ERROR_CODES)[number];

export class CodemapToolError extends Error {
  code: CodemapToolErrorCode;

  constructor(code: CodemapToolErrorCode, message: string) {
    super(message);
    this.name = "CodemapToolError";
    this.code = code;
  }
}

export interface CodemapValidationResultOk {
  ok: true;
}

export interface CodemapValidationResultErr {
  ok: false;
  message: string;
}

export type CodemapValidationResult =
  | CodemapValidationResultOk
  | CodemapValidationResultErr;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function normalizeRequestedPath(pathValue: string, repoRoot: string): string {
  const normalized = normalizePath(pathValue, repoRoot);
  const absolute = toAbsolute(normalized, repoRoot);
  const resolvedRoot = resolve(repoRoot);
  if (!isSubpath(absolute, resolvedRoot)) {
    throw new CodemapToolError(
      "READ_DENIED",
      `Path must be inside repository root: ${pathValue}`,
    );
  }
  return normalized;
}

function collectTargetPaths(
  requestedPaths: readonly string[],
  repoFiles: readonly string[],
): string[] {
  const fileSet = new Set(repoFiles);
  const targets = new Set<string>();

  for (const pathValue of requestedPaths) {
    if (fileSet.has(pathValue)) {
      targets.add(pathValue);
      continue;
    }

    const directoryPrefix = pathValue === "." ? "" : `${pathValue.replace(/\/+$/u, "")}/`;
    const matches = repoFiles.filter((filePath) =>
      directoryPrefix.length === 0 ? true : filePath.startsWith(directoryPrefix),
    );
    if (matches.length === 0) {
      throw new CodemapToolError("NOT_FOUND", `Path is not in repository files: ${pathValue}`);
    }
    for (const match of matches) {
      targets.add(match);
    }
  }

  return [...targets].sort((left, right) => left.localeCompare(right));
}

function normalizeLookupResults(
  results: readonly CodemapResultItem[],
): CodemapResultItem[] {
  return results
    .map((item) => ({
      path: item.path,
      language: item.language,
      lines: item.lines,
      symbols: [...item.symbols].sort((left, right) => {
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.signature.localeCompare(right.signature);
      }),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function buildCodemapsFromFiles(
  paths: readonly string[],
  options: CodemapLookupOptions,
  context: CodemapToolsContext,
): Promise<CodemapResultItem[]> {
  const readFileText = context.readFileText ?? ((absolutePath: string) => readFile(absolutePath, "utf8"));
  const parserFactory =
    context.parserFactory ??
    ((repoRoot: string) => TreeSitterCodemapParser.create({ projectRoot: repoRoot }));

  let parser: TreeSitterCodemapParser | null = null;
  try {
    parser = await parserFactory(context.repoRoot);
  } catch (error) {
    throw new CodemapToolError(
      "UNAVAILABLE",
      `Failed to initialize codemap parser: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const entries: CodemapResultItem[] = [];
    for (const pathValue of paths) {
      const language = detectCodemapLanguage(pathValue);
      if (!language) {
        continue;
      }

      const absolutePath = toAbsolute(pathValue, context.repoRoot);
      let content: string;
      try {
        content = await readFileText(absolutePath);
      } catch (error) {
        throw new CodemapToolError(
          "NOT_FOUND",
          `Unable to read file for codemap: ${pathValue} (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }

      const parsed = await parser.parse(content, language);
      const symbols = parsed.tree
        ? extractSymbolsFromTree(parsed.tree, language, {
            detail: options.detail,
            maxSymbols: options.maxSymbols,
          })
        : [];
      entries.push({
        path: pathValue,
        language,
        lines: countContentLines(content),
        symbols,
      });
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    parser.dispose();
  }
}

export function validateCodemapArgs(args: unknown): CodemapValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  if (
    !Array.isArray(args.paths) ||
    args.paths.length === 0 ||
    args.paths.some((pathValue) => typeof pathValue !== "string" || pathValue.trim().length === 0)
  ) {
    return { ok: false, message: "args.paths must be a non-empty array of strings" };
  }

  if (
    args.detail !== undefined &&
    (typeof args.detail !== "string" || !CODEMAP_DETAILS.includes(args.detail as CodemapDetail))
  ) {
    return { ok: false, message: "args.detail must be one of: summary, complete" };
  }

  if (args.max_symbols !== undefined && readPositiveInteger(args.max_symbols) === null) {
    return { ok: false, message: "args.max_symbols must be a positive integer" };
  }

  if (args.max_results !== undefined && readPositiveInteger(args.max_results) === null) {
    return { ok: false, message: "args.max_results must be a positive integer" };
  }

  return { ok: true };
}

export async function executeCodemap(
  args: CodemapArgs,
  context: CodemapToolsContext,
): Promise<CodemapResultPayload> {
  const detail: CodemapDetail = args.detail ?? "summary";
  const maxSymbols = args.max_symbols;
  const maxResults = args.max_results;
  const repoRoot = resolve(context.repoRoot);
  const requestedPaths = args.paths.map((pathValue) =>
    normalizeRequestedPath(pathValue, repoRoot),
  );
  const targetPaths = collectTargetPaths(requestedPaths, context.repoFiles);
  const effectivePaths =
    maxResults !== undefined ? targetPaths.slice(0, maxResults) : targetPaths;

  let lookupResults: CodemapResultItem[];
  if (context.codemapLookup) {
    lookupResults = await context.codemapLookup(effectivePaths, {
      detail,
      maxSymbols,
      maxResults,
    });
  } else {
    lookupResults = await buildCodemapsFromFiles(
      effectivePaths,
      {
        detail,
        maxSymbols,
        maxResults,
      },
      context,
    );
  }

  const payload: CodemapResultPayload = {
    paths: requestedPaths,
    detail,
    results: normalizeLookupResults(lookupResults),
  };

  return enforceCodemapTruncation(payload, {
    maxSymbols,
    maxResults,
  });
}
