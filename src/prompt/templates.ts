export type PromptTemplateMode = "plan" | "question" | "review" | "context";

export interface PromptTemplateDefinition {
  mode: PromptTemplateMode;
  description: string;
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
