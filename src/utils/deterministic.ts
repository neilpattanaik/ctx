import { createHash } from "node:crypto";

const DEFAULT_HASH_LENGTH = 12;
const RUN_ID_HASH_LENGTH = 8;
const DEFAULT_ELLIPSIS = "...";

export function stableSort<T>(
  items: readonly T[],
  compareFn: (a: T, b: T) => number,
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const compared = compareFn(left.item, right.item);
      if (compared !== 0) {
        return compared;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function stableHash(content: string, length = DEFAULT_HASH_LENGTH): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error("length must be a positive integer");
  }

  return createHash("sha256").update(content).digest("hex").slice(0, length);
}

function formatRunTimestamp(timestamp: Date): string {
  const year = timestamp.getUTCFullYear().toString().padStart(4, "0");
  const month = (timestamp.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = timestamp.getUTCDate().toString().padStart(2, "0");
  const hours = timestamp.getUTCHours().toString().padStart(2, "0");
  const minutes = timestamp.getUTCMinutes().toString().padStart(2, "0");
  const seconds = timestamp.getUTCSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

export function generateRunId(repoRoot: string, timestamp: Date): string {
  const timeSegment = formatRunTimestamp(timestamp);
  const rootHash = stableHash(repoRoot, RUN_ID_HASH_LENGTH);
  return `${timeSegment}-${rootHash}`;
}

export function truncateStable(
  text: string,
  maxChars: number,
  ellipsis = DEFAULT_ELLIPSIS,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error("maxChars must be a non-negative integer");
  }

  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars === 0) {
    return "";
  }

  if (ellipsis.length >= maxChars) {
    return ellipsis.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - ellipsis.length)}${ellipsis}`;
}
