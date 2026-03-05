import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type PromptTemplateMode = "plan" | "question" | "review" | "context";

export interface PromptTemplateDefinition {
  mode: PromptTemplateMode;
  description: string;
  body: string;
}

export interface PromptTemplateRecord {
  name: string;
  description: string;
  body: string;
  source: "built_in" | "custom";
  path?: string;
}

export interface TemplateLoaderIo {
  readDir(path: string): readonly string[];
  readFile(path: string): string;
}

export interface ParsedTemplateFrontmatter {
  attributes: Record<string, string>;
  body: string;
}

const PLAN_TEMPLATE = `<!-- CTX:BEGIN -->
<ctx_metadata>
repo_root: {{REPO_ROOT}}
run_id: {{RUN_ID}}
mode: plan
budget_tokens: {{BUDGET_TOKENS}}
estimated_prompt_tokens: {{PROMPT_TOKENS_ESTIMATE}}
line_numbers: {{LINE_NUMBERS}}
privacy_mode: {{PRIVACY_MODE}}
discovery_backend: {{DISCOVERY_BACKEND}}
</ctx_metadata>
<task>
{{TASK}}
</task>
<open_questions>
{{OPEN_QUESTIONS}}
</open_questions>
<repo_overview>
{{REPO_OVERVIEW}}
</repo_overview>
<file_tree>
{{TREE}}
</file_tree>
<discovery_handoff_summary>
{{HANDOFF_SUMMARY}}
</discovery_handoff_summary>
<codemaps>
{{CODEMAPS}}
</codemaps>
<files>
{{FILES}}
</files>
<git_diff>
{{GIT_DIFF}}
</git_diff>
<instructions>
You are an expert software architect. Architecture planning only.
Using only the context above, provide:
1) outcome and acceptance criteria
2) key assumptions
3) current architecture summary
4) proposed architecture changes
5) file-by-file change plan (no code)
6) implementation sequence
7) test strategy
8) risks and mitigations
9) explicit gaps in context
</instructions>
<token_report>
{{TOKEN_REPORT}}
</token_report>
<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->`;

const QUESTION_TEMPLATE = `<!-- CTX:BEGIN -->
<ctx_metadata>
repo_root: {{REPO_ROOT}}
run_id: {{RUN_ID}}
mode: question
budget_tokens: {{BUDGET_TOKENS}}
estimated_prompt_tokens: {{PROMPT_TOKENS_ESTIMATE}}
</ctx_metadata>
<task>
{{TASK}}
</task>
<repo_overview>
{{REPO_OVERVIEW}}
</repo_overview>
<file_tree>
{{TREE}}
</file_tree>
<codemaps>
{{CODEMAPS}}
</codemaps>
<files>
{{FILES}}
</files>
<instructions>
Answer as a grounded explanation of how the code works.
Reference specific files and line numbers when available.
Trace relevant call flows and enumerate behavior variants.
If context is insufficient, list exact additional files needed.
</instructions>
<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->`;

const REVIEW_TEMPLATE = `<!-- CTX:BEGIN -->
<ctx_metadata>
repo_root: {{REPO_ROOT}}
run_id: {{RUN_ID}}
mode: review
budget_tokens: {{BUDGET_TOKENS}}
estimated_prompt_tokens: {{PROMPT_TOKENS_ESTIMATE}}
diff_mode: {{DIFF_MODE}}
</ctx_metadata>
<task>
{{TASK}}
</task>
<git_diff>
{{GIT_DIFF}}
</git_diff>
<repo_overview>
{{REPO_OVERVIEW}}
</repo_overview>
<file_tree>
{{TREE}}
</file_tree>
<codemaps>
{{CODEMAPS}}
</codemaps>
<files>
{{FILES}}
</files>
<instructions>
Perform a thorough code review.
Output:
- Summary
- Findings grouped by severity (Critical / Warning / Suggestion)
For each finding include issue, impact, location, and fix direction.
Also evaluate API changes, edge cases, security, and tests.
</instructions>
<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->`;

const CONTEXT_TEMPLATE = `<!-- CTX:BEGIN -->
<ctx_metadata>
repo_root: {{REPO_ROOT}}
run_id: {{RUN_ID}}
mode: context
budget_tokens: {{BUDGET_TOKENS}}
estimated_prompt_tokens: {{PROMPT_TOKENS_ESTIMATE}}
</ctx_metadata>
<task>
{{TASK}}
</task>
<repo_overview>
{{REPO_OVERVIEW}}
</repo_overview>
<file_tree>
{{TREE}}
</file_tree>
<codemaps>
{{CODEMAPS}}
</codemaps>
<files>
{{FILES}}
</files>
<git_diff>
{{GIT_DIFF}}
</git_diff>
<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->`;

const BUILT_IN_TEMPLATES: Record<PromptTemplateMode, PromptTemplateDefinition> = {
  plan: {
    mode: "plan",
    description: "Architecture and implementation planning template",
    body: PLAN_TEMPLATE,
  },
  question: {
    mode: "question",
    description: "Grounded code explanation template",
    body: QUESTION_TEMPLATE,
  },
  review: {
    mode: "review",
    description: "Code review template with severity-grouped findings",
    body: REVIEW_TEMPLATE,
  },
  context: {
    mode: "context",
    description: "Raw context package template without extra instructions",
    body: CONTEXT_TEMPLATE,
  },
};

const BUILT_IN_TEMPLATE_ORDER: PromptTemplateMode[] = [
  "plan",
  "question",
  "review",
  "context",
];

const CUSTOM_TEMPLATES_SUBDIR = ".ctx/templates";
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

const DEFAULT_TEMPLATE_IO: TemplateLoaderIo = {
  readDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
};

export function isPromptTemplateMode(value: string): value is PromptTemplateMode {
  return BUILT_IN_TEMPLATE_ORDER.includes(value as PromptTemplateMode);
}

export function getBuiltInTemplate(mode: PromptTemplateMode): string {
  return BUILT_IN_TEMPLATES[mode].body;
}

export function getBuiltInTemplateOrThrow(mode: string): string {
  if (!isPromptTemplateMode(mode)) {
    throw new Error(`Unknown built-in template mode: ${mode}`);
  }
  return getBuiltInTemplate(mode);
}

export function listBuiltInTemplateModes(): PromptTemplateMode[] {
  return [...BUILT_IN_TEMPLATE_ORDER];
}

export function listBuiltInTemplates(): PromptTemplateDefinition[] {
  return BUILT_IN_TEMPLATE_ORDER.map((mode) => ({
    ...BUILT_IN_TEMPLATES[mode],
  }));
}

function normalizeTemplateName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function isMarkdownTemplateFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".md");
}

function parseFrontmatterLine(line: string): [key: string, value: string] | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 1) {
    return null;
  }
  const key = line.slice(0, separatorIndex).trim().toLowerCase();
  if (key.length === 0) {
    return null;
  }
  const rawValue = line.slice(separatorIndex + 1).trim();
  if (rawValue.length === 0) {
    return [key, ""];
  }
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return [key, rawValue.slice(1, -1)];
  }
  return [key, rawValue];
}

export function parseTemplateFrontmatter(content: string): ParsedTemplateFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(FRONTMATTER_OPEN)) {
    return {
      attributes: {},
      body: normalized,
    };
  }

  const closeIndex = normalized.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (closeIndex < 0) {
    return {
      attributes: {},
      body: normalized,
    };
  }

  const frontmatterRaw = normalized
    .slice(FRONTMATTER_OPEN.length, closeIndex)
    .trim();
  const body = normalized.slice(closeIndex + FRONTMATTER_CLOSE.length);
  const attributes: Record<string, string> = {};

  if (frontmatterRaw.length > 0) {
    for (const line of frontmatterRaw.split("\n")) {
      const parsed = parseFrontmatterLine(line);
      if (parsed === null) {
        continue;
      }
      attributes[parsed[0]] = parsed[1];
    }
  }

  return {
    attributes,
    body,
  };
}

function listTemplateFiles(repoRoot: string, io: TemplateLoaderIo): string[] {
  const templatesDir = join(repoRoot, CUSTOM_TEMPLATES_SUBDIR);
  try {
    return io
      .readDir(templatesDir)
      .filter(isMarkdownTemplateFile)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error instanceof Error && /ENOENT/.test(error.message)) {
      return [];
    }
    throw error;
  }
}

export function loadCustomTemplates(
  repoRoot: string,
  io: TemplateLoaderIo = DEFAULT_TEMPLATE_IO,
): PromptTemplateRecord[] {
  const templatesDir = join(repoRoot, CUSTOM_TEMPLATES_SUBDIR);
  const byName = new Map<string, PromptTemplateRecord>();
  for (const fileName of listTemplateFiles(repoRoot, io)) {
    const absolutePath = join(templatesDir, fileName);
    const content = io.readFile(absolutePath);
    const parsed = parseTemplateFrontmatter(content);
    const inferredName = basename(fileName, ".md");
    const preferredName = parsed.attributes.name?.trim() ?? inferredName;
    const normalizedName = normalizeTemplateName(preferredName);
    if (normalizedName.length < 1) {
      continue;
    }

    byName.set(normalizedName, {
      name: normalizedName,
      description:
        parsed.attributes.description?.trim() ??
        `Custom template (${normalizedName})`,
      body: parsed.body,
      source: "custom",
      path: absolutePath,
    });
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function listAvailableTemplates(
  repoRoot: string,
  io: TemplateLoaderIo = DEFAULT_TEMPLATE_IO,
): PromptTemplateRecord[] {
  const templates = new Map<string, PromptTemplateRecord>();

  for (const mode of BUILT_IN_TEMPLATE_ORDER) {
    const builtIn = BUILT_IN_TEMPLATES[mode];
    templates.set(mode, {
      name: mode,
      description: builtIn.description,
      body: builtIn.body,
      source: "built_in",
    });
  }

  for (const custom of loadCustomTemplates(repoRoot, io)) {
    templates.set(custom.name, custom);
  }

  return [...templates.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function getTemplateByName(
  name: string,
  repoRoot: string,
  io: TemplateLoaderIo = DEFAULT_TEMPLATE_IO,
): PromptTemplateRecord | null {
  const normalizedName = normalizeTemplateName(name);
  if (normalizedName.length < 1) {
    return null;
  }

  const templates = listAvailableTemplates(repoRoot, io);
  const match = templates.find((template) => template.name === normalizedName);
  return match ?? null;
}
