import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

interface MatcherLayer {
  baseDir: string;
  source: string;
  matcher: Ignore;
}

export interface GitignoreLayerInfo {
  source: string;
  baseDir: string;
}

export interface GitignoreMatcher {
  layers: GitignoreLayerInfo[];
  shouldIgnore: (pathValue: string, isDirectory?: boolean) => boolean;
}

export interface CreateGitignoreMatcherOptions {
  repoRoot: string;
  useGitignore?: boolean;
  extraIgnorePatterns?: string[];
  resolveGlobalGitignorePath?: (repoRoot: string) => string | null;
}

interface GitConfigPathRecord {
  origin: string | null;
  value: string;
}

function toPosix(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

function normalizeToRepoRelative(repoRoot: string, pathValue: string): string | null {
  const absoluteRoot = resolve(repoRoot);
  const absolutePath = isAbsolute(pathValue)
    ? resolve(pathValue)
    : resolve(absoluteRoot, pathValue);
  const relativePath = toPosix(relative(absoluteRoot, absolutePath));

  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("../")
  ) {
    return null;
  }

  return relativePath;
}

function readIgnorePatterns(pathValue: string): string[] {
  if (!existsSync(pathValue)) {
    return [];
  }

  return readFileSync(pathValue, "utf8")
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function collectNestedGitignoreFiles(repoRoot: string): string[] {
  const root = resolve(repoRoot);
  const discovered: string[] = [];

  function walk(currentDir: string): void {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      if (entry.isFile() && entry.name === ".gitignore") {
        discovered.push(fullPath);
        continue;
      }
      if (entry.isDirectory() && entry.name !== ".git") {
        walk(fullPath);
      }
    }
  }

  walk(root);
  return discovered;
}

function parseGitConfigPathRecord(rawOutput: string): GitConfigPathRecord | null {
  const parts = rawOutput.split("\0").filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return {
      origin: parts[parts.length - 2] ?? null,
      value: parts[parts.length - 1] ?? "",
    };
  }

  if (parts.length === 1) {
    return {
      origin: null,
      value: parts[0] ?? "",
    };
  }

  return null;
}

function expandHome(pathValue: string): string | null {
  if (pathValue === "~") {
    return process.env.HOME ?? null;
  }
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    const home = process.env.HOME;
    if (!home) {
      return null;
    }
    return resolve(home, pathValue.slice(2));
  }
  return pathValue;
}

function resolveGitConfigPath(
  record: GitConfigPathRecord,
  repoRoot: string,
): string | null {
  const expandedValue = expandHome(record.value);
  if (!expandedValue || expandedValue.length === 0) {
    return null;
  }
  if (isAbsolute(expandedValue)) {
    return resolve(expandedValue);
  }

  if (record.origin?.startsWith("file:")) {
    const configPath = record.origin.slice("file:".length);
    if (configPath.length > 0) {
      return resolve(dirname(configPath), expandedValue);
    }
  }

  const home = process.env.HOME;
  if (home) {
    return resolve(home, expandedValue);
  }

  return resolve(repoRoot, expandedValue);
}

function defaultResolveGlobalGitignorePath(repoRoot: string): string | null {
  try {
    const output = execFileSync(
      "git",
      ["config", "--null", "--show-origin", "--path", "core.excludesFile"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const record = parseGitConfigPathRecord(output);
    if (!record || record.value.length === 0) {
      return null;
    }
    return resolveGitConfigPath(record, repoRoot);
  } catch {
    // Fallback for environments where --show-origin/--null are unavailable.
    try {
      const output = execFileSync("git", ["config", "--path", "core.excludesFile"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (output.length === 0) {
        return null;
      }

      return resolveGitConfigPath({ origin: null, value: output }, repoRoot);
    } catch {
      return null;
    }
  }
}

function createLayer(baseDir: string, source: string, patterns: string[]): MatcherLayer | null {
  if (patterns.length === 0) {
    return null;
  }

  const matcher = ignore();
  matcher.add(patterns);

  return {
    baseDir: toPosix(baseDir),
    source,
    matcher,
  };
}

function relativeToLayerBase(layerBaseDir: string, candidatePath: string): string | null {
  if (layerBaseDir.length === 0) {
    return candidatePath;
  }

  if (candidatePath === layerBaseDir) {
    return "";
  }

  if (candidatePath.startsWith(`${layerBaseDir}/`)) {
    return candidatePath.slice(layerBaseDir.length + 1);
  }

  return null;
}

export function createGitignoreMatcher(
  options: CreateGitignoreMatcherOptions,
): GitignoreMatcher {
  const repoRoot = resolve(options.repoRoot);
  const layers: MatcherLayer[] = [];
  const useGitignore = options.useGitignore ?? true;

  if (useGitignore) {
    const gitignorePaths = collectNestedGitignoreFiles(repoRoot);
    for (const gitignorePath of gitignorePaths) {
      const patterns = readIgnorePatterns(gitignorePath);
      const baseDir = normalizeToRepoRelative(repoRoot, dirname(gitignorePath)) ?? "";
      const layer = createLayer(baseDir === "." ? "" : baseDir, gitignorePath, patterns);
      if (layer) {
        layers.push(layer);
      }
    }

    const resolveGlobalGitignorePath =
      options.resolveGlobalGitignorePath ?? defaultResolveGlobalGitignorePath;
    const globalGitignorePath = resolveGlobalGitignorePath(repoRoot);
    if (globalGitignorePath) {
      const globalPatterns = readIgnorePatterns(globalGitignorePath);
      const globalLayer = createLayer("", globalGitignorePath, globalPatterns);
      if (globalLayer) {
        layers.push(globalLayer);
      }
    }
  }

  const extraLayer = createLayer(
    "",
    "<config.repo.ignore>",
    options.extraIgnorePatterns ?? [],
  );
  if (extraLayer) {
    layers.push(extraLayer);
  }

  const layerInfo: GitignoreLayerInfo[] = layers.map((layer) => ({
    source: layer.source,
    baseDir: layer.baseDir,
  }));

  return {
    layers: layerInfo,
    shouldIgnore(pathValue: string, isDirectory = false): boolean {
      const candidate = normalizeToRepoRelative(repoRoot, pathValue);
      if (!candidate) {
        return false;
      }

      let ignored = false;
      for (const layer of layers) {
        const scopedPath = relativeToLayerBase(layer.baseDir, candidate);
        if (scopedPath === null || scopedPath.length === 0) {
          continue;
        }

        const probePath = isDirectory
          ? `${scopedPath.replace(/\/+$/g, "")}/`
          : scopedPath;
        const result = layer.matcher.test(probePath);
        if (result.ignored) {
          ignored = true;
        }
        if (result.unignored) {
          ignored = false;
        }
      }

      return ignored;
    },
  };
}
