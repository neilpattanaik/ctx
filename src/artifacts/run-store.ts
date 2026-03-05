import {
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createRunRecord, type RunRecord } from "../types";
import { generateRunId } from "../utils/deterministic";

export interface StoredRunRecord extends RunRecord {
  normalizedTerms?: string[];
  discoveryBackend?: string;
  discoveryDurationMs?: number;
  toolCallLog?: unknown[];
  startedAt?: string;
  completedAt?: string;
}

export interface PersistRunArtifactsOptions {
  repoRoot: string;
  runsDir: string;
  storeRuns: boolean;
  runRecord: StoredRunRecord;
  promptText?: string;
}

export interface PersistRunArtifactsResult {
  runId: string;
  runsRoot: string;
  runDirectory: string;
  runRecordPath: string;
  promptPath?: string;
  latestPath: string;
  persisted: boolean;
}

const LATEST_POINTER_NAME = "latest";
const LATEST_POINTER_FALLBACK_FILE = "latest-run-id";
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function resolveRunsRoot(repoRoot: string, runsDir: string): string {
  return isAbsolute(runsDir) ? runsDir : resolve(repoRoot, runsDir);
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSafeRunId(runId: string): string {
  const normalized = runId.trim();
  if (
    normalized.length < 1 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    !SAFE_RUN_ID_PATTERN.test(normalized)
  ) {
    throw new Error(
      `Invalid run ID '${runId}': run IDs must match ${SAFE_RUN_ID_PATTERN.source} and must not contain path separators`,
    );
  }
  return normalized;
}

async function updateLatestPointer(runsRoot: string, runId: string): Promise<string> {
  const latestPath = resolve(runsRoot, LATEST_POINTER_NAME);
  const latestFallbackPath = resolve(runsRoot, LATEST_POINTER_FALLBACK_FILE);
  const tempLinkPath = resolve(
    runsRoot,
    `.latest-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await symlink(runId, tempLinkPath, "dir");
    await rename(tempLinkPath, latestPath);
  } catch {
    // Cleanup best-effort if temporary link still exists.
    try {
      await unlink(tempLinkPath);
    } catch {
      // Ignore temp-link cleanup errors.
    }
  }

  // Keep a file fallback for environments where symlink replacement is
  // restricted (Windows, containerized CI, mounted volumes, etc.).
  try {
    await writeFile(latestFallbackPath, `${runId}\n`, "utf8");
  } catch {
    // Latest pointer updates are best-effort metadata and should not make
    // run artifact persistence fail.
  }

  return latestPath;
}

export function createDeterministicRunId(
  repoRoot: string,
  timestamp = new Date(),
): string {
  return generateRunId(resolve(repoRoot), timestamp);
}

export async function persistRunArtifacts(
  options: PersistRunArtifactsOptions,
): Promise<PersistRunArtifactsResult> {
  const runRecord = createRunRecord(options.runRecord);
  const runId = assertSafeRunId(runRecord.runId);
  const runsRoot = resolveRunsRoot(options.repoRoot, options.runsDir);
  const runDirectory = resolve(runsRoot, runId);
  const runRecordPath = resolve(runDirectory, "run.json");
  const latestPath = resolve(runsRoot, LATEST_POINTER_NAME);

  if (!options.storeRuns) {
    return {
      runId,
      runsRoot,
      runDirectory,
      runRecordPath,
      latestPath,
      persisted: false,
    };
  }

  await mkdir(runDirectory, { recursive: true });
  await writeFile(runRecordPath, formatJson(runRecord), "utf8");

  let promptPath: string | undefined;
  if (options.promptText !== undefined) {
    promptPath = resolve(runDirectory, "prompt.md");
    await writeFile(promptPath, options.promptText, "utf8");
  }

  await updateLatestPointer(runsRoot, runId);

  return {
    runId,
    runsRoot,
    runDirectory,
    runRecordPath,
    promptPath,
    latestPath,
    persisted: true,
  };
}

export async function readLatestRunId(
  repoRoot: string,
  runsDir: string,
): Promise<string | null> {
  const runsRoot = resolveRunsRoot(repoRoot, runsDir);
  const latestPath = resolve(runsRoot, LATEST_POINTER_NAME);
  const latestFallbackPath = resolve(runsRoot, LATEST_POINTER_FALLBACK_FILE);

  const normalizePointerValue = (value: string): string | null => {
    const normalized = value.replace(/\\/g, "/").trim().replace(/\/+$/, "");
    if (normalized.length === 0) {
      return null;
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "..")) {
      return null;
    }
    const runId = segments.pop();
    if (!runId || runId === "." || runId === "..") {
      return null;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
      return null;
    }
    return runId;
  };

  try {
    const pointer = await readFile(latestFallbackPath, "utf8");
    const fromFile = normalizePointerValue(pointer);
    if (fromFile !== null) {
      return fromFile;
    }
  } catch {
    // Fall through to legacy fallback.
  }

  try {
    const target = await readlink(latestPath);
    const fromSymlink = normalizePointerValue(target);
    if (fromSymlink !== null) {
      return fromSymlink;
    }
  } catch {
    // Fall through to legacy fallback.
  }

  // Legacy compatibility: older versions may write a plain-text pointer to
  // "latest" instead of "latest-run-id".
  try {
    const pointer = await readFile(latestPath, "utf8");
    return normalizePointerValue(pointer);
  } catch {
    return null;
  }
}
