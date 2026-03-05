import { posix } from "node:path";

const FILE_TREE_MODES = ["auto", "full", "folders", "selected"] as const;
const DEFAULT_AUTO_FULL_THRESHOLD = 200;
const DEFAULT_FOLDERS_MAX_DEPTH = 3;
const DEFAULT_TREE_LINE_LIMIT = 500;

export type FileTreeMode = (typeof FILE_TREE_MODES)[number];
type ResolvedFileTreeMode = Exclude<FileTreeMode, "auto">;

export const TREE_TOOL_ERROR_CODES = ["INVALID_ARGS", "INTERNAL_ERROR"] as const;
export type TreeToolErrorCode = (typeof TREE_TOOL_ERROR_CODES)[number];

export class TreeToolError extends Error {
  code: TreeToolErrorCode;

  constructor(code: TreeToolErrorCode, message: string) {
    super(message);
    this.name = "TreeToolError";
    this.code = code;
  }
}

export interface FileTreeArgs {
  mode?: FileTreeMode;
  max_depth?: number;
  path?: string;
}

export interface FileTreeValidationResultOk {
  ok: true;
}

export interface FileTreeValidationResultErr {
  ok: false;
  message: string;
}

export type FileTreeValidationResult =
  | FileTreeValidationResultOk
  | FileTreeValidationResultErr;

export interface TreeToolsContext {
  repoFiles: readonly string[];
  selectedPaths?: readonly string[];
  defaultMode?: FileTreeMode;
  autoFullThreshold?: number;
  maxLines?: number;
}

interface TreeNodeBase {
  name: string;
  path: string;
}

interface DirectoryNode extends TreeNodeBase {
  kind: "directory";
  fileCount: number;
  children: Map<string, TreeNode>;
}

interface FileNode extends TreeNodeBase {
  kind: "file";
}

type TreeNode = DirectoryNode | FileNode;

export interface TreeLineEntry {
  depth: number;
  text: string;
}

export interface FileTreeToolResult {
  mode: ResolvedFileTreeMode;
  path?: string;
  max_depth: number | null;
  lines: TreeLineEntry[];
  tree: string;
  truncation: {
    truncated: boolean;
    max_lines: number;
    omitted_entries: number;
  };
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

function normalizeTreePath(pathValue: string): string {
  const normalized = posix.normalize(pathValue.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (normalized === "." || normalized === "") {
    return "";
  }
  const trimmed = normalized.replace(/\/+$/, "");
  if (trimmed.startsWith("../") || trimmed === ".." || trimmed.startsWith("/")) {
    throw new TreeToolError(
      "INVALID_ARGS",
      "args.path must be a repository-relative path without traversal",
    );
  }
  return trimmed;
}

function normalizeRepoFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => normalizeTreePath(entry)).filter((entry) => entry.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeSelectedPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) {
    return [];
  }
  return [...new Set(paths.map((entry) => normalizeTreePath(entry)).filter((entry) => entry.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function createDirectoryNode(pathValue: string): DirectoryNode {
  const parts = pathValue.split("/");
  const name = parts[parts.length - 1] ?? pathValue;
  return {
    kind: "directory",
    path: pathValue,
    name,
    fileCount: 0,
    children: new Map<string, TreeNode>(),
  };
}

function createFileNode(pathValue: string): FileNode {
  const parts = pathValue.split("/");
  const name = parts[parts.length - 1] ?? pathValue;
  return {
    kind: "file",
    path: pathValue,
    name,
  };
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function resolveMode(
  requestedMode: FileTreeMode | undefined,
  filesCount: number,
  defaultMode: FileTreeMode | undefined,
  autoFullThreshold: number,
): ResolvedFileTreeMode {
  const effectiveMode = requestedMode ?? defaultMode ?? "auto";
  if (effectiveMode !== "auto") {
    return effectiveMode;
  }
  return filesCount < autoFullThreshold ? "full" : "folders";
}

function resolveMaxDepth(
  requestedMaxDepth: number | undefined,
  resolvedMode: ResolvedFileTreeMode,
): number {
  const explicitDepth = readPositiveInteger(requestedMaxDepth);
  if (explicitDepth !== null) {
    return explicitDepth;
  }
  if (resolvedMode === "folders") {
    return DEFAULT_FOLDERS_MAX_DEPTH;
  }
  return Number.POSITIVE_INFINITY;
}

function resolveTreeLineLimit(maxLines: number | undefined): number {
  const parsed = readPositiveInteger(maxLines);
  if (parsed !== null) {
    return parsed;
  }
  return DEFAULT_TREE_LINE_LIMIT;
}

function filterToSubtree(files: readonly string[], subtreePath: string): string[] {
  if (subtreePath.length === 0) {
    return [...files];
  }

  const prefix = `${subtreePath}/`;
  return files.filter((filePath) => filePath === subtreePath || filePath.startsWith(prefix));
}

function applySelectedModeFiles(
  repoFiles: readonly string[],
  selectedPaths: readonly string[],
): string[] {
  if (selectedPaths.length === 0) {
    return [];
  }
  const fileSet = new Set(repoFiles);
  return selectedPaths.filter((pathValue) => fileSet.has(pathValue));
}

function buildTreeRoot(files: readonly string[]): DirectoryNode {
  const root = createDirectoryNode(".");

  for (const filePath of files) {
    const segments = filePath.split("/");
    let current = root;
    current.fileCount += 1;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }

      const nextPath = current.path === "." ? segment : `${current.path}/${segment}`;
      const isLeafFile = index === segments.length - 1;

      if (isLeafFile) {
        if (!current.children.has(segment)) {
          current.children.set(segment, createFileNode(nextPath));
        }
        break;
      }

      const existing = current.children.get(segment);
      if (existing?.kind === "directory") {
        existing.fileCount += 1;
        current = existing;
        continue;
      }

      const directory = createDirectoryNode(nextPath);
      directory.fileCount += 1;
      current.children.set(segment, directory);
      current = directory;
    }
  }

  return root;
}

function formatDirectoryLine(node: DirectoryNode, depth: number, includeFullPath: boolean): string {
  const label = includeFullPath ? node.path : node.name;
  const suffix = node.path === "." ? "" : "/";
  return `${"  ".repeat(depth)}${label}${suffix} [${node.fileCount} files]`;
}

function formatFileLine(node: FileNode, depth: number): string {
  return `${"  ".repeat(depth)}${node.name}`;
}

function renderTreeLines(
  node: DirectoryNode,
  mode: ResolvedFileTreeMode,
  maxDepth: number,
  includeRootNode: boolean,
): TreeLineEntry[] {
  const lines: TreeLineEntry[] = [];

  if (includeRootNode && node.path !== ".") {
    lines.push({
      depth: 0,
      text: formatDirectoryLine(node, 0, true),
    });
  }

  const renderChildren = (directory: DirectoryNode, currentDepth: number): void => {
    if (currentDepth > maxDepth) {
      return;
    }

    const orderedChildren = [...directory.children.values()].sort(compareNodes);
    for (const child of orderedChildren) {
      if (child.kind === "directory") {
        lines.push({
          depth: currentDepth,
          text: formatDirectoryLine(child, currentDepth, false),
        });
        renderChildren(child, currentDepth + 1);
        continue;
      }

      if (mode !== "folders") {
        lines.push({
          depth: currentDepth,
          text: formatFileLine(child, currentDepth),
        });
      }
    }
  };

  renderChildren(node, includeRootNode ? 1 : 0);
  return lines;
}

function applyLineLimit(
  lines: readonly TreeLineEntry[],
  maxLines: number,
): {
  lines: TreeLineEntry[];
  truncated: boolean;
  omittedEntries: number;
} {
  if (lines.length <= maxLines) {
    return {
      lines: [...lines],
      truncated: false,
      omittedEntries: 0,
    };
  }

  const visibleLimit = Math.max(0, maxLines - 1);
  const visibleLines = lines.slice(0, visibleLimit);
  const omittedEntries = lines.length - visibleLines.length;
  return {
    lines: [
      ...visibleLines,
      {
        depth: 0,
        text: `... (${omittedEntries} more entries)`,
      },
    ],
    truncated: true,
    omittedEntries,
  };
}

export function validateFileTreeArgs(args: unknown): FileTreeValidationResult {
  if (args === undefined) {
    return { ok: true };
  }
  if (!isRecord(args)) {
    return { ok: false, message: "args must be an object when provided" };
  }

  if (
    args.mode !== undefined &&
    (typeof args.mode !== "string" || !FILE_TREE_MODES.includes(args.mode as FileTreeMode))
  ) {
    return {
      ok: false,
      message: "args.mode must be one of: auto, full, folders, selected",
    };
  }

  if (args.max_depth !== undefined && readPositiveInteger(args.max_depth) === null) {
    return { ok: false, message: "args.max_depth must be a positive integer" };
  }

  if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim().length === 0)) {
    return { ok: false, message: "args.path must be a non-empty string" };
  }

  return { ok: true };
}

export function executeFileTree(
  args: FileTreeArgs | undefined,
  context: TreeToolsContext,
): FileTreeToolResult {
  const repoFiles = normalizeRepoFiles(context.repoFiles);
  const selectedPaths = normalizeSelectedPaths(context.selectedPaths);

  const autoFullThreshold = readPositiveInteger(context.autoFullThreshold) ?? DEFAULT_AUTO_FULL_THRESHOLD;
  const resolvedMode = resolveMode(args?.mode, repoFiles.length, context.defaultMode, autoFullThreshold);
  const maxDepth = resolveMaxDepth(args?.max_depth, resolvedMode);
  const maxLines = resolveTreeLineLimit(context.maxLines);
  const subtreePath = args?.path ? normalizeTreePath(args.path) : "";

  const baseFiles =
    resolvedMode === "selected"
      ? applySelectedModeFiles(repoFiles, selectedPaths)
      : repoFiles;
  const scopedFiles = filterToSubtree(baseFiles, subtreePath);
  const treeRoot = buildTreeRoot(scopedFiles);
  const rootNode =
    subtreePath.length === 0
      ? treeRoot
      : (treeRoot.children.get(subtreePath.split("/")[0] ?? "") as DirectoryNode | undefined);

  if (subtreePath.length > 0) {
    const parts = subtreePath.split("/");
    let current: DirectoryNode | undefined = treeRoot;
    for (const part of parts) {
      const child = current.children.get(part);
      if (!child || child.kind !== "directory") {
        current = undefined;
        break;
      }
      current = child;
    }

    const subtreeLines = current
      ? renderTreeLines(current, resolvedMode, maxDepth, true)
      : [];
    const limited = applyLineLimit(subtreeLines, maxLines);
    return {
      mode: resolvedMode,
      path: subtreePath,
      max_depth: Number.isFinite(maxDepth) ? maxDepth : null,
      lines: limited.lines,
      tree: limited.lines.map((entry) => entry.text).join("\n"),
      truncation: {
        truncated: limited.truncated,
        max_lines: maxLines,
        omitted_entries: limited.omittedEntries,
      },
    };
  }

  const lines = renderTreeLines(treeRoot, resolvedMode, maxDepth, false);
  const limited = applyLineLimit(lines, maxLines);
  return {
    mode: resolvedMode,
    max_depth: Number.isFinite(maxDepth) ? maxDepth : null,
    lines: limited.lines,
    tree: limited.lines.map((entry) => entry.text).join("\n"),
    truncation: {
      truncated: limited.truncated,
      max_lines: maxLines,
      omitted_entries: limited.omittedEntries,
    },
  };
}
