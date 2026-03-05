const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;
const EMPTY_XML_TAG_PATTERN = /<([A-Za-z0-9_:-]+)>\s*<\/\1>/gs;

const SUPPORTED_PLACEHOLDERS = [
  "REPO_ROOT",
  "RUN_ID",
  "BUDGET_TOKENS",
  "PROMPT_TOKENS_ESTIMATE",
  "LINE_NUMBERS",
  "PRIVACY_MODE",
  "DISCOVERY_BACKEND",
  "DIFF_MODE",
  "TASK",
  "OPEN_QUESTIONS",
  "REPO_OVERVIEW",
  "TREE",
  "HANDOFF_SUMMARY",
  "CODEMAPS",
  "FILES",
  "GIT_DIFF",
  "TOKEN_REPORT",
  "MANIFEST",
] as const;

export type TemplatePlaceholder = (typeof SUPPORTED_PLACEHOLDERS)[number];
export type TemplateValues = Partial<Record<TemplatePlaceholder, string>>;

export interface TemplateRenderOptions {
  logger?: (message: string) => void;
}

export interface TemplateRenderResult {
  output: string;
  warnings: string[];
}

const SUPPORTED_PLACEHOLDER_SET = new Set<string>(SUPPORTED_PLACEHOLDERS);

function pruneEmptySections(text: string): string {
  let previous = text;
  let current = text.replace(EMPTY_XML_TAG_PATTERN, "");

  while (current !== previous) {
    previous = current;
    current = current.replace(EMPTY_XML_TAG_PATTERN, "");
  }

  return current
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function renderTemplate(
  template: string,
  values: TemplateValues,
  options?: TemplateRenderOptions,
): TemplateRenderResult {
  const warnings: string[] = [];
  const unknownSeen = new Set<string>();

  const replaced = template.replace(
    PLACEHOLDER_PATTERN,
    (fullMatch, placeholderName: string) => {
      if (!SUPPORTED_PLACEHOLDER_SET.has(placeholderName)) {
        if (!unknownSeen.has(placeholderName)) {
          const warning = `Unknown placeholder left unchanged: {{${placeholderName}}}`;
          warnings.push(warning);
          options?.logger?.(warning);
          unknownSeen.add(placeholderName);
        }
        return fullMatch;
      }

      const replacement = values[placeholderName as TemplatePlaceholder] ?? "";
      return replacement;
    },
  );

  return {
    output: pruneEmptySections(replaced),
    warnings,
  };
}
