import { runGitCommand } from "./runner";

export type GitStatusChangeType =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unmerged";

export interface GitStatusChange {
  path: string;
  status: GitStatusChangeType;
}

export interface GitStatusSummary {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitStatusChange[];
}

export interface CollectGitStatusOptions {
  cwd: string;
  runGitCommandImpl?: typeof runGitCommand;
}

function parseAheadBehind(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+) -(\d+)$/);
  if (!match) {
    return { ahead: 0, behind: 0 };
  }
  return {
    ahead: Number.parseInt(match[1]!, 10),
    behind: Number.parseInt(match[2]!, 10),
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function classifyTrackedChange(xy: string): Exclude<GitStatusChangeType, "untracked" | "unmerged"> {
  if (xy.includes("R") || xy.includes("C")) {
    return "renamed";
  }
  if (xy.includes("A")) {
    return "added";
  }
  if (xy.includes("D")) {
    return "deleted";
  }
  return "modified";
}

function parseTrackedPath(line: string): string {
  const tabIndex = line.indexOf("\t");
  const beforeTab = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
  const parts = beforeTab.trim().split(/\s+/);
  return normalizePath(parts[parts.length - 1] ?? "");
}

export function parseGitStatusPorcelainV2(output: string): GitStatusSummary {
  const lines = output.split("\n").map((line) => line.trimEnd());

  let branchHead = "HEAD";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const changes: GitStatusChange[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("# ")) {
      if (line.startsWith("# branch.head ")) {
        branchHead = line.slice("# branch.head ".length).trim();
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const parsedUpstream = line.slice("# branch.upstream ".length).trim();
        upstream = parsedUpstream.length > 0 ? parsedUpstream : undefined;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const parsed = parseAheadBehind(line.slice("# branch.ab ".length).trim());
        ahead = parsed.ahead;
        behind = parsed.behind;
      }
      continue;
    }

    if (line.startsWith("? ")) {
      changes.push({
        path: normalizePath(line.slice(2).trim()),
        status: "untracked",
      });
      continue;
    }

    if (line.startsWith("u ")) {
      const parts = line.split(/\s+/);
      changes.push({
        path: normalizePath(parts[parts.length - 1] ?? ""),
        status: "unmerged",
      });
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(/\s+/, 3)[1] ?? "";
      const path = parseTrackedPath(line);
      if (path.length > 0) {
        changes.push({
          path,
          status: classifyTrackedChange(xy),
        });
      }
    }
  }

  return {
    branch: branchHead === "(detached)" ? "HEAD (detached)" : branchHead,
    upstream,
    ahead,
    behind,
    changes,
  };
}

export function collectGitStatus(
  options: CollectGitStatusOptions,
): GitStatusSummary | null {
  const runGit = options.runGitCommandImpl ?? runGitCommand;
  const result = runGit({
    cwd: options.cwd,
    args: ["status", "--porcelain=v2", "--branch"],
  });

  if (!result.ok) {
    if (result.failureKind === "NOT_GIT_REPO") {
      return null;
    }
    if (result.failureKind === "NO_COMMITS") {
      return {
        branch: "HEAD (no commits)",
        ahead: 0,
        behind: 0,
        changes: [],
      };
    }
    return null;
  }

  return parseGitStatusPorcelainV2(result.stdout);
}
