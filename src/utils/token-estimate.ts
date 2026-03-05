import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export interface TokenEstimateOptions {
  charsPerToken?: number;
}

export interface SelectionSliceText {
  text: string;
}

export interface SelectionEntryText {
  mode: "full" | "slices" | "codemap_only";
  text?: string;
  slices?: readonly SelectionSliceText[];
}

function resolveCharsPerToken(options?: TokenEstimateOptions): number {
  const charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new Error("charsPerToken must be a finite number greater than 0");
  }

  return charsPerToken;
}

export function estimateTokensFromText(
  text: string,
  options?: TokenEstimateOptions,
): number {
  if (text.length === 0) {
    return 0;
  }

  const charsPerToken = resolveCharsPerToken(options);
  return Math.ceil(text.length / charsPerToken);
}

export function estimateTokensFromFile(
  filePath: string,
  options?: TokenEstimateOptions,
): number {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, "utf8");
  return estimateTokensFromText(content, options);
}

export function estimateTokensFromSelection(
  selection: readonly SelectionEntryText[],
  options?: TokenEstimateOptions,
): number {
  let total = 0;

  for (const entry of selection) {
    if (entry.mode === "slices") {
      const slices = entry.slices ?? [];
      for (const slice of slices) {
        total += estimateTokensFromText(slice.text, options);
      }
      continue;
    }

    total += estimateTokensFromText(entry.text ?? "", options);
  }

  return total;
}
