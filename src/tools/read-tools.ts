import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isBinaryFile } from "../scanner/binary-detect";
import { type PrivacyMode, type RepoConfig } from "../types";
import { isSubpath, matchGlob, normalizePath } from "../utils/paths";
import { enforceReadFileTruncation, type ReadFileResultPayload } from "./truncation";

const STRICT_PRIVACY_MAX_LINES = 20;
const DEFAULT_SNIPPET_BEFORE = 8;
const DEFAULT_SNIPPET_AFTER = 8;

export const READ_TOOL_ERROR_CODES = [
  "READ_DENIED",
  "NOT_FOUND",
  "INVALID_ARGS",
  "BINARY_FILE",
  "SIZE_EXCEEDED",
  "INTERNAL_ERROR",
] as const;

export type ReadToolErrorCode = (typeof READ_TOOL_ERROR_CODES)[number];

export class ReadToolError extends Error {
  code: ReadToolErrorCode;

  constructor(code: ReadToolErrorCode, message: string) {
    super(message);
    this.name = "ReadToolError";
    this.code = code;
  }
}

export interface ReadToolsContext {
  repoRoot: string;
  repoConfig: Pick<RepoConfig, "maxFileBytes">;
  privacyMode: PrivacyMode;
  neverIncludeGlobs: readonly string[];
  lineNumbers: boolean;
  binarySniffBytes?: number;
  isBinaryFileImpl?: typeof isBinaryFile;
  readTextFile?: (absolutePath: string) => Promise<string>;
  statFile?: (absolutePath: string) => Promise<{ size: number; isFile: () => boolean }>;
}

export interface ReadFileArgs {
  path: string;
  start_line?: number;
  limit?: number;
}

export interface ReadSnippetArgs {
  path: string;
  anchor: number | string;
  before?: number;
  after?: number;
}

export interface ReadToolValidationResultOk {
  ok: true;
}

export interface ReadToolValidationResultErr {
  ok: false;
  message: string;
}

export type ReadToolValidationResult =
  | ReadToolValidationResultOk
  | ReadToolValidationResultErr;

export interface ReadSnippetResultPayload extends ReadFileResultPayload {
  anchor: number | string;
  anchor_line: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeLimit(limit: number | undefined, privacyMode: PrivacyMode): number | undefined {
  if (privacyMode !== "strict") {
    return limit;
  }

  if (limit === undefined) {
    return STRICT_PRIVACY_MAX_LINES;
  }

  return Math.min(limit, STRICT_PRIVACY_MAX_LINES);
}

function toLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function toText(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.join("\n")}\n`;
}

function formatContent(
  pathValue: string,
  lines: readonly string[],
  startLine: number,
  limit: number | undefined,
  lineNumbers: boolean,
): ReadFileResultPayload {
  return enforceReadFileTruncation(
    {
      path: pathValue,
      content: toText(lines),
      start_line: startLine,
      limit,
      line_numbers: lineNumbers,
    },
    {
      startLine,
      limit,
      lineNumbers,
    },
  );
}

function isPathDenied(pathValue: string, neverIncludeGlobs: readonly string[]): boolean {
  for (const pattern of neverIncludeGlobs) {
    if (matchGlob(pathValue, pattern)) {
      return true;
    }
  }
  return false;
}

function buildDeniedError(pathValue: string): ReadToolError {
  return new ReadToolError("READ_DENIED", `Path is blocked by never-include rules: ${pathValue}`);
}

async function resolveReadablePath(
  pathValue: string,
  context: ReadToolsContext,
): Promise<{
  repoRelativePath: string;
  absolutePath: string;
  size: number;
}> {
  const repoRoot = resolve(context.repoRoot);
  const normalizedPath = normalizePath(pathValue, repoRoot);
  const absolutePath = resolve(repoRoot, normalizedPath);

  if (!isSubpath(absolutePath, repoRoot)) {
    throw buildDeniedError(pathValue);
  }

  if (isPathDenied(normalizedPath, context.neverIncludeGlobs)) {
    throw buildDeniedError(normalizedPath);
  }

  let fileStats: { size: number; isFile: () => boolean };
  try {
    fileStats = context.statFile
      ? await context.statFile(absolutePath)
      : await stat(absolutePath);
  } catch {
    throw new ReadToolError("NOT_FOUND", `File does not exist: ${normalizedPath}`);
  }

  if (!fileStats.isFile()) {
    throw new ReadToolError("NOT_FOUND", `Path is not a file: ${normalizedPath}`);
  }

  const binaryDetector = context.isBinaryFileImpl ?? isBinaryFile;
  if (
    binaryDetector(absolutePath, {
      sniffBytes: context.binarySniffBytes,
    })
  ) {
    throw new ReadToolError("BINARY_FILE", `Binary files cannot be read: ${normalizedPath}`);
  }

  if (fileStats.size > context.repoConfig.maxFileBytes) {
    throw new ReadToolError(
      "SIZE_EXCEEDED",
      `File exceeds max_file_bytes=${context.repoConfig.maxFileBytes}: ${normalizedPath}`,
    );
  }

  return {
    repoRelativePath: normalizedPath,
    absolutePath,
    size: fileStats.size,
  };
}

function readAnchorLine(anchor: number | string, lines: readonly string[]): number {
  if (typeof anchor === "number") {
    return Math.max(1, anchor);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(anchor)) {
      return index + 1;
    }
  }

  throw new ReadToolError("NOT_FOUND", `Anchor string was not found in file: ${anchor}`);
}

export function validateReadFileArgs(args: unknown): ReadToolValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return { ok: false, message: "args.path must be a non-empty string" };
  }

  if (args.start_line !== undefined && readPositiveInteger(args.start_line) === null) {
    return { ok: false, message: "args.start_line must be a positive integer" };
  }

  if (args.limit !== undefined && readPositiveInteger(args.limit) === null) {
    return { ok: false, message: "args.limit must be a positive integer" };
  }

  return { ok: true };
}

export function validateReadSnippetArgs(args: unknown): ReadToolValidationResult {
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object" };
  }

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return { ok: false, message: "args.path must be a non-empty string" };
  }

  const anchor = args.anchor;
  if (
    !(
      (typeof anchor === "number" && readPositiveInteger(anchor) !== null) ||
      (typeof anchor === "string" && anchor.trim().length > 0)
    )
  ) {
    return {
      ok: false,
      message: "args.anchor must be a positive integer line number or non-empty string",
    };
  }

  if (args.before !== undefined && readNonNegativeInteger(args.before) === null) {
    return { ok: false, message: "args.before must be a non-negative integer" };
  }

  if (args.after !== undefined && readNonNegativeInteger(args.after) === null) {
    return { ok: false, message: "args.after must be a non-negative integer" };
  }

  return { ok: true };
}

export async function executeReadFile(
  args: ReadFileArgs,
  context: ReadToolsContext,
): Promise<ReadFileResultPayload> {
  const resolved = await resolveReadablePath(args.path, context);
  const textReader =
    context.readTextFile ?? (async (absolutePath: string) => readFile(absolutePath, "utf8"));

  const fileContent = await textReader(resolved.absolutePath);
  const allLines = toLines(fileContent);
  const requestedStartLine = args.start_line ?? 1;
  const startLine = Math.max(1, requestedStartLine);
  const startIndex = startLine - 1;
  const slicedLines = startIndex >= allLines.length ? [] : allLines.slice(startIndex);
  const limit = normalizeLimit(args.limit, context.privacyMode);

  return formatContent(
    resolved.repoRelativePath,
    slicedLines,
    startLine,
    limit,
    context.lineNumbers,
  );
}

export async function executeReadSnippet(
  args: ReadSnippetArgs,
  context: ReadToolsContext,
): Promise<ReadSnippetResultPayload> {
  const resolved = await resolveReadablePath(args.path, context);
  const textReader =
    context.readTextFile ?? (async (absolutePath: string) => readFile(absolutePath, "utf8"));

  const fileContent = await textReader(resolved.absolutePath);
  const lines = toLines(fileContent);
  const anchorLine = readAnchorLine(args.anchor, lines);
  const before = args.before ?? DEFAULT_SNIPPET_BEFORE;
  const after = args.after ?? DEFAULT_SNIPPET_AFTER;

  const snippetStartLine = Math.max(1, anchorLine - before);
  const snippetEndLine = Math.max(snippetStartLine, anchorLine + after);
  const boundedEndLine = Math.min(lines.length, snippetEndLine);
  const snippetLines =
    snippetStartLine > lines.length
      ? []
      : lines.slice(snippetStartLine - 1, boundedEndLine);
  const snippetLimit = normalizeLimit(snippetLines.length, context.privacyMode);

  const formatted = formatContent(
    resolved.repoRelativePath,
    snippetLines,
    snippetStartLine,
    snippetLimit,
    context.lineNumbers,
  );

  return {
    ...formatted,
    anchor: args.anchor,
    anchor_line: anchorLine,
  };
}
