import { stableSort } from "../utils/deterministic";
import type { SearchContentHit } from "./ripgrep";

const ELLIPSIS = "…";
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_EXCERPTS_PER_FILE = 3;
const DEFAULT_MAX_EXCERPT_CHARS = 200;

export interface SearchFormattingOptions {
  maxFiles?: number;
  maxExcerptsPerFile?: number;
  maxExcerptChars?: number;
}

export interface FormattedSearchExcerpt {
  line: number;
  excerpt: string;
  match: string;
}

export interface FormattedSearchResultItem {
  path: string;
  hits: number;
  top_excerpts: FormattedSearchExcerpt[];
}

export interface SearchFormattingMeta {
  max_files: number;
  max_excerpts_per_file: number;
  max_excerpt_chars: number;
}

export interface FormattedSearchResultPayload {
  pattern: string;
  mode: string;
  results: FormattedSearchResultItem[];
  truncation: SearchFormattingMeta;
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return ELLIPSIS;
  }
  return `${text.slice(0, maxChars - 1)}${ELLIPSIS}`;
}

function compareExcerpts(
  left: FormattedSearchExcerpt,
  right: FormattedSearchExcerpt,
): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.excerpt.localeCompare(right.excerpt);
}

function compareResults(
  left: FormattedSearchResultItem,
  right: FormattedSearchResultItem,
): number {
  if (left.hits !== right.hits) {
    return right.hits - left.hits;
  }
  return left.path.localeCompare(right.path);
}

export function formatContentSearchResults(
  pattern: string,
  hits: readonly SearchContentHit[],
  options: SearchFormattingOptions = {},
): FormattedSearchResultPayload {
  const maxFiles = readPositiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const maxExcerptsPerFile = readPositiveInteger(
    options.maxExcerptsPerFile,
    DEFAULT_MAX_EXCERPTS_PER_FILE,
  );
  const maxExcerptChars = readPositiveInteger(
    options.maxExcerptChars,
    DEFAULT_MAX_EXCERPT_CHARS,
  );

  const grouped = new Map<string, FormattedSearchExcerpt[]>();
  for (const hit of hits) {
    const match = hit.submatches[0] ?? "";
    const excerpts = grouped.get(hit.path) ?? [];
    excerpts.push({
      line: hit.line,
      excerpt: truncateExcerpt(hit.excerpt, maxExcerptChars),
      match,
    });
    grouped.set(hit.path, excerpts);
  }

  const results = Array.from(grouped.entries()).map(([path, excerpts]) => {
    const orderedExcerpts = stableSort(excerpts, compareExcerpts).slice(
      0,
      maxExcerptsPerFile,
    );
    return {
      path,
      hits: excerpts.length,
      top_excerpts: orderedExcerpts,
    };
  });

  return {
    pattern,
    mode: "content",
    results: stableSort(results, compareResults).slice(0, maxFiles),
    truncation: {
      max_files: maxFiles,
      max_excerpts_per_file: maxExcerptsPerFile,
      max_excerpt_chars: maxExcerptChars,
    },
  };
}
