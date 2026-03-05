# `ctx` — Deterministic Context Builder + Prompt Wrapper**

## 0) Product definition

### Name

**`ctx`** (CLI executable)

### Purpose

`ctx` takes a user task and a repository, performs **discovery-only** exploration (LLM-assisted or deterministic), and outputs a **single paste-ready prompt** (Markdown/XML/plain) that includes a token-budgeted, high-signal context package plus mode-specific instructions (plan/question/review/context).

### Core guarantee

Given the same repo state, task text, and configuration, `ctx` produces **stable, explainable outputs** and stays within a defined token budget via deterministic enforcement.

---

## 1) Goals and non-goals

### Primary goals

1. **Maximize downstream answer quality** by providing the reasoning model:

   * relevant entrypoints,
   * adjacent dependencies,
   * necessary configuration and data flow context,
   * minimal noise.
2. **Predictable token budgeting** with deterministic trimming/degradation.
3. **Operational safety**

   * respect ignore rules,
   * avoid binaries,
   * redact secrets,
   * provide privacy modes suitable for sensitive repos.
4. **Low-friction UX**

   * `ctx "task"` works with sensible defaults.
5. **Explainability**

   * show *what was included* and *why*,
   * show what was dropped and *why*.

### Non-goals (v1)

* Editing the repository
* Running builds/tests/linters
* Long-running multi-step coding agents
* Acting as an MCP server (optional future extension)
* Uploading content anywhere without explicit configuration (privacy-first defaults)

---

## 2) Key concept: staged pipeline (discovery ≠ reasoning)

`ctx` is explicitly a **preprocessor**. It ends by producing a prompt for a separate reasoning model.

### Pipeline

1. **Parse & normalize the task**
2. **Repository scan + index update** (incremental)
3. **Discovery** (choose backend: LLM-assisted or deterministic)
4. **Selection enforcement** (budget + limits + determinism)
5. **Prompt assembly** (mode template + context package)
6. **Artifacts** (manifest, explain report, optional logs)

---

## 3) Primary user experience

### Default usage (plan mode)

```bash
ctx "Add GitHub OAuth login and integrate it into the existing auth flow."
```

* **stdout:** paste-ready prompt only
* **stderr:** progress, warnings, token report summary

### Multiline task input

```bash
cat task.md | ctx
```

### Output destinations

```bash
ctx "Investigate intermittent 500s on login" -o prompt.md
ctx "Refactor the background job retry policy" --copy
```

### Modes

```bash
ctx "How does the caching layer work?" --mode question
ctx "Review my recent changes" --mode review --diff uncommitted
ctx "Just give me curated context" --mode context
```

### Inspection and reproducibility

```bash
ctx --dry-run "Add request ID propagation"
ctx explain last
ctx manifest last -o manifest.json
ctx open last   # opens the generated prompt in $PAGER (optional)
```

---

## 4) CLI design

### Synopsis

```bash
ctx [TASK_TEXT] [flags]

ctx init
ctx agents
ctx index [--rebuild]
ctx templates (list|show <name>)
ctx explain (last|<run-id>)
ctx manifest (last|<run-id>) [-o <path>]
```

### Core flags

#### Mode and output

* `--mode <plan|question|review|context>` (default: `plan`)
* `--format <markdown|markdown+xmltags|xml|plain>` (default: `markdown+xmltags`)
* `-o, --output <path>` (default: stdout)
* `--copy` / `--clipboard`
* `--quiet` (suppress stderr)
* `--verbose` (include discovery transcript + timings in artifacts; still keep stdout clean)
* `--json-summary` (machine-readable run summary to stderr)

#### Budgeting and limits

* `--budget <tokens>` (default: 60000)
* `--reserve <tokens>` (default: 15000) (display warning threshold; not part of prompt)
* `--max-files <n>` (default: 80)
* `--max-full-files <n>` (default: 10)
* `--max-slices-per-file <n>` (default: 4)
* `--max-file-bytes <n>` (default: 1500000)
* `--fail-on-overbudget` (optional strict behavior)

#### Discovery backend

* `--discover <auto|llm|local-cli|offline>` (default: `auto`)
* `--agent <openai|anthropic|google|claude-cli|codex-cli|gemini-cli|custom>` (optional override)
* `--model <string>` (discovery model name; optional)
* `--agent-timeout <seconds>` (default: 600)
* `--agent-max-turns <n>` (default: 20)
* `--no-llm` (force offline deterministic discovery; equivalent to `--discover offline`)

#### Repo and indexing

* `--repo <path>` (default: current directory)
* `--cache <repo|global|off>` (default: repo)
* `--cache-dir <path>` (override)
* `--no-index` (do not use persistent index; still allow scanning/search)
* `ctx index --rebuild` (full re-index)

#### Context shaping

* `--tree <auto|full|selected|none>` (default: auto)
* `--codemaps <auto|selected|none|complete>` (default: auto)
* `--line-numbers <on|off>` (default: on)

#### Inclusion overrides

* `--include <glob>` (repeatable)
* `--exclude <glob>` (repeatable)
* `--prefer-full <glob>` (repeatable)
* `--prefer-slices <glob>` (repeatable)
* `--prefer-codemap <glob>` (repeatable)
* `--entrypoint <path>` (repeatable)

#### Git integration

* `--diff <off|uncommitted|staged|unstaged|compare:<revspec>|main|<branch>|back:<N>>` (default: off)
* `--git-status <on|off>` (default: on)
* `--git-max-files <n>` (default: 20)
* `--git-max-patch-tokens <n>` (default: 6000)

#### Privacy and redaction

* `--privacy <normal|strict|airgap>` (default: normal)
* `--redact <on|off>` (default: on)
* `--redact-pattern <regex>` (repeatable)
* `--never-include <glob>` (repeatable; stronger than exclude—cannot be overridden by agent)

### Exit codes

* `0` success
* `2` invalid usage
* `3` repo not found / no readable files
* `4` index error
* `5` discovery backend failure / timeout (still may output prompt if fallback succeeds)
* `6` prompt render failure
* `7` output failure (file/clipboard)

---

## 5) Configuration

### Precedence (high → low)

1. CLI flags
2. Repo config: `<repo>/.ctx/config.toml`
3. User config: `~/.config/ctx/config.toml` (platform equivalent)
4. Defaults

### Config schema (TOML)

```toml
[defaults]
mode = "plan"
format = "markdown+xmltags"
budget_tokens = 60000
reserve_tokens = 15000
tree_mode = "auto"
codemaps = "auto"
max_files = 80
max_full_files = 10
max_slices_per_file = 4
line_numbers = true

[repo]
root = "."
use_gitignore = true
ignore = ["**/dist/**", "**/.venv/**", "**/node_modules/**", "**/.git/**"]
max_file_bytes = 1500000
skip_binary = true

[index]
enabled = true
engine = "sqlite"   # sqlite|memory
rebuild_on_schema_change = true

[discovery]
discover = "auto"   # auto|llm|local-cli|offline
provider = "openai" # openai|anthropic|google (when discover=llm)
model = ""          # optional
timeout_seconds = 600
max_turns = 20

[local_cli]
agent_priority = ["codex-cli", "claude-cli", "gemini-cli"]
codex_cli_command = "codex"
claude_cli_command = "claude"
gemini_cli_command = "gemini"

[git]
diff = "off"
git_status = true
max_files = 20
max_patch_tokens = 6000

[privacy]
mode = "normal"      # normal|strict|airgap
redact = true
never_include = ["**/.env", "**/*secret*", "**/*private_key*"]
extra_redact_patterns = []

[output]
include_manifest_footer = true
include_token_report = true
path_display = "relative"     # relative|absolute
store_runs = true
runs_dir = ".ctx/runs"
```

### Environment variables

* `CTX_REPO`, `CTX_BUDGET`, `CTX_MODE`, `CTX_FORMAT`
* `CTX_DISCOVER`, `CTX_PROVIDER`, `CTX_MODEL`
* Provider keys (by convention): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`

---

## 6) Discovery backends (the hybrid solution)

A real-world tool needs multiple discovery options:

### 6.1 Offline deterministic discovery (always available)

Used when:

* `--no-llm` / `--privacy airgap`, or
* LLM backend fails, or
* `--dry-run`

Mechanisms:

* task term extraction (identifiers, paths, endpoints, config keys)
* index-based file ranking (symbol hits + content hits + import proximity)
* entrypoint heuristics (routes/controllers, CLI entry, main files)
* git-diff bias when diff mode is enabled
* deterministic selection + deterministic degradation

This guarantees the tool is useful even without any model access.

### 6.2 LLM-assisted discovery via provider API

Used when:

* user config provides provider + key, and
* privacy mode allows it (`normal` or `strict` with constraints)

Important constraints:

* The agent sees only what the tool host returns (tool-mediated).
* The agent is instructed: **discovery only**, no solution plan.

### 6.3 LLM-assisted discovery via local CLI agent adapters

Used when:

* user prefers Claude/Codex/Gemini CLIs, or enterprise mandates those entrypoints
* the adapter can capture text deterministically

This backend is treated as **best-effort** and must still operate through the same tool protocol and enforcement rules as API-based discovery.

### 6.4 Backend selection (`--discover auto`)

Priority logic:

1. If `--privacy airgap` → offline
2. Else if provider API is configured and reachable → LLM (API)
3. Else if a supported local CLI agent is available → local-cli
4. Else → offline

---

## 7) Discovery agent role and behavioral contract

### Agent role

The discovery agent is a **codebase research agent**.

It must:

* identify relevant entrypoints and dependencies
* request evidence via tools (search/read/codemap)
* propose a selection (full/slices/codemap-only)
* produce a factual handoff summary and open questions
* stay within budget guidance

It must not:

* propose implementation approaches
* write code
* output a step-by-step solution plan

### Strong guardrails (enforced)

Even if the agent misbehaves, `ctx` enforces:

* ignore/never-include rules
* file size and binary exclusions
* max limits
* deterministic budget normalization
* output format constraints

---

## 8) Tool protocol (strict, backend-agnostic)

### 8.1 Tool call envelope (agent → ctx)

Agent tool calls must appear in fenced blocks:

````text
```ctx_tool
{"id":"t1","tool":"file_search","args":{"pattern":"OAuth","mode":"content","max_results":20}}
```
````

Rules:

* Valid JSON
* `id` required
* One tool call per code block
* Multiple blocks per turn allowed; executed sequentially

### 8.2 Tool result envelope (ctx → agent)

````text
```ctx_result
{"id":"t1","ok":true,"result":{...},"meta":{"truncated":false,"tokens_estimate":123}}
```
````

If failure:

````text
```ctx_result
{"id":"t1","ok":false,"error":{"code":"READ_DENIED","message":"permission denied: src/secrets.txt"}}
```
````

### 8.3 Agent completion block (final)

Agent must output:

````text
```ctx_final
{
  "open_questions": [
    {"question":"...", "why_it_matters":"...", "default_assumption":"..."}
  ],
  "handoff_summary": {
    "entrypoints":[{"path":"...","notes":"..."}],
    "key_modules":[{"path":"...","notes":"..."}],
    "data_flows":[{"name":"...", "notes":"..."}],
    "config_knobs":[{"key":"...", "where":"...", "notes":"..."}],
    "tests":[{"path":"...", "notes":"..."}]
  },
  "selection": [
    {"path":"src/auth/login.ts","mode":"full","priority":"core","rationale":"..."},
    {"path":"src/auth/router.ts","mode":"slices","priority":"core","rationale":"...","slices":[
      {"start_line":120,"end_line":220,"description":"login route handler"}
    ]},
    {"path":"src/auth/types.ts","mode":"codemap_only","priority":"ref","rationale":"..."}
  ]
}
```
````

`ctx` validates schema. If invalid:

* return a structured error and request a retry (if turns remain)
* otherwise fall back to deterministic discovery and proceed

---

## 9) Tool catalog (agent-facing)

### 9.1 Repo navigation

* `repo_info()`

  * repo root, language stats, index status, ignore summary, build/package hints
* `file_tree({mode, max_depth, path?})`

  * modes: `auto|full|folders|selected`
* `list_files({glob?, limit?})`

### 9.2 Search and read

* `file_search({pattern, mode, regex?, filter?, context_lines?, max_results?})`

  * `mode`: `path|content|both|auto`
  * `filter`: `{extensions?, paths?, exclude?}`
* `read_file({path, start_line?, limit?})`
* `read_snippet({path, anchor, before, after})`

### 9.3 Code structure

* `codemap({paths, detail?, max_symbols?, max_results?})`

  * `detail`: `summary|complete`
  * can accept directories → returns aggregated “module codemap” (see below)

### 9.4 Git (optional)

* `git_status()`
* `git_diff({compare, detail?, scope?, max_files?})`

  * `compare`: `uncommitted|staged|unstaged|<revspec>|main|<branch>|back:<N>`
  * `detail`: `summary|patches|full`
  * `scope`: `all|selected`

### 9.5 Selection building (agent proposes; ctx enforces)

* `select_add({path, mode, slices?, priority?, rationale})`
* `select_remove({path})`
* `select_get({view})` (`summary|files|content|codemaps`)
* `select_clear()`

### 9.6 Budgeting

* `token_estimate({text? , path? , selection?})`
* `budget_report()`

---

## 10) Repo indexing and scanning

### 10.1 Scanning requirements

* Determine repo root:

  * `--repo` or current directory
  * optionally resolve git root
* Respect `.gitignore` by default
* Apply extra ignore patterns
* Skip binaries:

  * null-byte detection + known binary extensions
* Skip oversized files unless explicitly forced by user `--include`

### 10.2 Persistent index (SQLite recommended)

Store:

* file metadata: path, size, mtime, hash, language
* extracted imports/exports (best-effort)
* symbol index (from codemaps)
* lexical search index (optional; ripgrep remains primary search tool)
* git metadata hints (optional): last commit touching file (only if cheap and enabled)

Update strategy:

* incremental update by mtime/hash
* rebuild on schema change or `ctx index --rebuild`

### 10.3 Progressive codemap strategy (solves PLAN 2’s scaling risk)

Codemaps are computed/cached for many files, but **not dumped wholesale** into the agent context.

Instead:

* `repo_info()` includes a compact “module map”:

  * top directories and their primary languages
  * a small set of high-level symbols per module (capped)
* The agent requests deeper codemaps with `codemap({paths:[...]})` as needed.
* The assembler includes codemaps in the final prompt for:

  * codemap-only files
  * selected modules where signatures help reasoning

This keeps discovery scalable while still leveraging codemaps.

---

## 11) Selection and budgeting (deterministic enforcement)

### 11.1 Representation modes

* **full**: entire file content
* **slices**: selected line ranges with labels and rationales
* **codemap_only**: signatures/exports/types only

### 11.2 Deterministic hard constraints

Enforced regardless of agent:

* `max_files`, `max_full_files`, `max_slices_per_file`
* max bytes per file
* ignore + never-include
* binary exclusion

### 11.3 Deterministic budget normalization (the “degradation ladder”)

If estimated tokens exceed `--budget`, `ctx` applies deterministic degradation in this order:

1. **Degrade lowest-priority `full` → `slices`**

   * slice around task hits / referenced symbols / strongest search hits
2. **Degrade lowest-priority `slices` → `codemap_only`**
3. **Drop lowest-priority `codemap_only`**
4. **Shrink codemap detail** (`complete` → `summary`, cap symbols)
5. **Shrink slices** (reduce context window, merge overlaps, keep function boundaries when possible)
6. **Reduce tree verbosity** (`full` → `selected` → `none`)
7. If still over budget:

   * emit warning
   * optionally fail if `--fail-on-overbudget`

### 11.4 Priority computation (stable ordering)

Priority score (deterministic) combines:

* explicit includes / task-mentioned paths (highest)
* git-changed files (high in review mode)
* entrypoint heuristics (routes/controllers/main)
* hit density for task terms
* import graph proximity to core files
* agent “priority” field (`core` > `support` > `ref`) as a weak signal (agent is advisory, not authoritative)

Tie-breaking:

* stable lexicographic path order
* stable symbol order from parser output

### 11.5 Slice construction rules

When slices are required and agent didn’t specify exact ranges:

1. Prefer AST-aware slicing via tree-sitter:

   * expand to enclosing function/class boundaries
2. Fallback:

   * ±N lines around strongest match
3. Merge overlaps; cap to `max_slices_per_file`
4. Always label:

   * `path`
   * `Lx-Ly`
   * description
   * rationale

---

## 12) Git integration (review-grade)

### 12.1 Diff behavior

* Always run git commands with safe flags:

  * `--no-ext-diff`, `--no-textconv`, `--color=never`, `GIT_TERMINAL_PROMPT=0`
* Diff modes:

  * `uncommitted`, `staged`, `unstaged`, `compare:<revspec>`, `main`, `<branch>`, `back:<N>`

### 12.2 Review mode behavior

When `--mode review`:

* default `--diff uncommitted` (unless overridden)
* pass changed file list as high-priority hints to discovery
* include diffs in prompt with a strict token cap (`--git-max-patch-tokens`)
* bias selection toward:

  * changed files (full or slices)
  * immediate dependencies
  * tests touching changed modules

---

## 13) Privacy, security, and governance

### 13.1 Privacy modes

* **normal**

  * LLM discovery allowed
  * full content may be shown to agent via tools (subject to redaction)
* **strict**

  * LLM discovery allowed, but agent is restricted:

    * no full file reads
    * codemaps + minimal snippets only
  * final prompt may still include full/slices for the *reasoning* model (user-controlled), but discovery quality tradeoff is explicit
* **airgap**

  * no external calls
  * offline deterministic discovery only

### 13.2 Redaction layer

Applied to:

* tool outputs returned to agent
* final prompt output (optional, configurable; recommended on by default)

Redaction includes:

* common secret patterns (API keys, tokens, private keys, JWTs)
* user-provided regex patterns
* “never include” paths/globs
* optional entropy-based high-risk string detector (careful to avoid false positives; emit markers rather than deleting lines)

Redaction output policy:

* replace sensitive substrings with `‹REDACTED:reason›`
* preserve line structure to keep line numbers stable where possible

### 13.3 Correctness constraints

* never include binary content
* always provide accurate line numbers for slices
* stable path normalization (relative/absolute consistent)

---

## 14) Output prompt: structure and templates

### 14.1 Output principles

* stdout is prompt only
* stable section ordering
* clear boundaries with XML-like tags (even in markdown mode) to help models parse

### 14.2 Standard prompt structure (applies to all modes)

1. **Metadata**

   * repo root/name
   * run id
   * mode, budget, token estimates (optional but recommended)
2. **Task**
3. **Open questions** (with defaults)
4. **Repo overview**

   * tree (depending on `--tree`)
   * build/config signals (package files, lockfiles, etc.)
   * git status summary (if enabled)
5. **Discovery handoff summary** (factual; no plan)
6. **Context package**

   * codemaps (selected)
   * file contents (full + slices)
   * git diffs (if enabled)
7. **Mode-specific instructions** (template)

### 14.3 Modes (instructions differ; context packaging also slightly tuned)

* **plan**

  * request: architecture changes + file-by-file plan + implementation sequence + tests + risks
* **question**

  * request: grounded explanation with references to files/functions
* **review**

  * request: code review with severity, correctness/security/edge cases/tests
* **context**

  * no instructions; raw curated context only

### 14.4 Template system

* Built-in templates: `plan`, `question`, `review`, `context`
* Custom templates in `.ctx/templates/*.md` with optional frontmatter:

  ```md
  ---
  name: team_plan
  description: "Plan with ADR and rollout gates"
  ---
  ```
* Placeholders:

  * `{{TASK}}`, `{{OPEN_QUESTIONS}}`, `{{TREE}}`, `{{REPO_OVERVIEW}}`
  * `{{HANDOFF_SUMMARY}}`, `{{CODEMAPS}}`, `{{FILES}}`, `{{GIT_DIFF}}`
  * `{{TOKEN_REPORT}}`, `{{MANIFEST}}`

---

## 15) Explainability and artifacts

### 15.1 Run records

For each run store (configurable):

* input task
* normalized task terms
* discovery backend used
* tool call log (optional)
* selection manifest (always)
* final prompt (optional)
* timing and token reports

Location:

* repo-local `.ctx/runs/<run_id>/...` (default)
* or global cache keyed by repo hash

### 15.2 `ctx explain`

Outputs:

* why each file was included
* why it is `full` vs `slices` vs `codemap_only`
* what constraints forced degradation/drops
* token usage by section and by file

### 15.3 `ctx manifest`

Outputs machine-readable JSON:

* repo info, ignore settings
* discovery backend + model
* selection list:

  * mode, slices, rationale, priority
* token estimates
* dropped candidates and reasons
* git settings used

---

## 16) Caching and performance targets

### 16.1 Cache strategy

* Codemap cache keyed by file hash
* Index stored in SQLite (incremental)
* Search uses ripgrep when available; fallback search otherwise
* Discovery tool read results cached for duration of run

### 16.2 Performance targets (practical, not aspirational)

* Small repo (<500 files):

  * cold: < 5–8 seconds to reach discovery
  * warm: < 2–3 seconds to reach discovery
* Large repo (<10k files):

  * cold: < 15–30 seconds (depending on disk)
  * warm: < 5–10 seconds
* Assembly: < 1 second
* Discovery: backend-dependent; enforce timeout and produce fallback output

Key design choice that enables these targets:

* incremental indexing
* progressive codemap disclosure (don’t serialize everything into agent context)

---

## 17) Error handling and resilience

### Behavior table (high-level)

* **No key / no agent available**

  * fall back to offline discovery; warn on stderr
* **Agent timeout / API rate limit**

  * retry limited times (configurable)
  * then fallback to offline discovery
  * still output a prompt (unless user requested strict failure)
* **File read denied**

  * skip; include in manifest with reason
* **Codemap parse failure**

  * omit codemap; optionally include as slices if relevant and allowed
* **Overbudget**

  * deterministic degradation; warn
  * fail only if `--fail-on-overbudget`

All warnings to stderr; stdout remains prompt-only.

---

## 18) Internal architecture (implementation blueprint)

### Major components

1. **CLI frontend**

   * argument parsing, command routing
2. **Config manager**

   * merge precedence, env overrides
3. **Repo scanner**

   * ignore handling, binary detection, size limits
4. **Index manager**

   * SQLite index, incremental updates
5. **Search engine**

   * ripgrep integration + fallback
6. **Codemap engine**

   * tree-sitter parsers + symbol extraction + cache
7. **Tool host**

   * executes tool calls, applies redaction, truncation, determinism rules
8. **Discovery runner**

   * backend adapters:

     * provider API runner
     * local CLI runner
     * offline runner
9. **Selection manager**

   * selection state, priorities, constraints
10. **Budget manager**

* token estimation + degradation ladder

11. **Prompt assembler**

* formatters (markdown, xml, plain), templates

12. **Artifacts store**

* runs, manifest, explain logs

### Determinism rules

* sequential tool execution
* stable sorting of outputs
* stable truncation rules (see below)
* stable run id generation (timestamp + short hash; include repo hash if desired)

---

## 19) Testing and QA (what makes this reliable)

### Tests to require before shipping

* **Golden prompt tests**

  * snapshot outputs for known repos and tasks
  * ensure stability across runs
* **Budget enforcement tests**

  * force overbudget scenarios and verify deterministic degradation order
* **Redaction tests**

  * known secret patterns redacted without breaking line numbering invariants
* **Binary/large-file exclusion tests**
* **Index incremental update tests**
* **Git diff correctness tests**
* **Adapter contract tests**

  * tool protocol parsing
  * `ctx_final` schema validation

### Acceptance criteria (v1)

1. `ctx "task"` produces a paste-ready prompt with no stdout noise.
2. Works without any LLM credentials (offline discovery) and still produces a sensible context package.
3. When LLM discovery is enabled, tool-mediated discovery produces higher-quality selections, but outputs remain within the same deterministic enforcement framework.
4. Overbudget behavior is deterministic and explainable.
5. `ctx explain` and `ctx manifest` work and are useful.
6. Redaction and ignore rules are honored.

---

## 20) Default templates (complete bodies)

Below are complete default template bodies for `markdown+xmltags` format. These are intentionally strict and verbose because they are designed to be pasted into a reasoning model.

### 20.1 Default `plan` template (`templates/plan.md`)

```md
<!-- CTX:BEGIN -->
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
You are an expert software architect. Your job is ARCHITECTURAL PLANNING ONLY.
Do NOT write implementation code unless explicitly asked. Do NOT assume missing context.

Using ONLY the context above, produce a detailed plan that is grounded in the actual codebase.

Required output format (use these headings in this order):

1) Outcome and acceptance criteria
- Precisely define what "done" means.
- Include user-visible behavior, API contracts, and non-functional requirements (security, performance, observability) when relevant.

2) Key assumptions
- Explicitly answer each open question.
- If you must assume, state the assumption and why it is the safest default.

3) Current architecture summary (as-is)
- Briefly describe the existing components involved, referencing specific files/modules.

4) Proposed architecture changes (to-be)
- Describe new/changed components, data flow, APIs, configuration, and how it integrates with existing patterns.
- Call out where behavior changes and where it must remain backward compatible.

5) File-by-file change plan (NO CODE)
For each file to modify/create:
- Path
- Purpose of change
- Key functions/classes to touch
- Inputs/outputs and error-handling expectations
- Any config/env changes

6) Implementation sequence
- Provide ordered steps with dependencies and checkpoints.
- Include migration/rollout sequencing if needed.

7) Test strategy
- Unit, integration, end-to-end tests
- What to mock vs what to run for real
- Where tests should live in this repo

8) Risks and mitigations
- Security risks, data migration risks, rollout risks, complexity risks
- Mitigation strategies and validation steps

9) If context is insufficient
- List EXACTLY what additional files or information you need and why.
- Be specific (paths, symbols, configs).
</instructions>

<token_report>
{{TOKEN_REPORT}}
</token_report>

<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->
```

### 20.2 Default `question` template

```md
<!-- CTX:BEGIN -->
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
Answer the task as a grounded explanation of how the code works.
Requirements:
- Reference specific files and (when present) line numbers.
- Trace relevant call flows across files.
- If there are multiple behaviors (e.g., feature flags, environment switches), enumerate them.
- If context is insufficient, list exactly which additional files/sections are needed.
</instructions>

<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->
```

### 20.3 Default `review` template

```md
<!-- CTX:BEGIN -->
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
Perform a thorough code review based on the diffs and context above.

Output format:
- Summary
- Findings (group by severity: Critical / Warning / Suggestion)
For each finding:
- What is the issue
- Why it matters (correctness, security, reliability, performance, maintainability)
- Where (file + line range if possible)
- Suggested fix direction (NO code unless explicitly requested)
Also evaluate:
- API/contract changes
- Error handling and edge cases
- Security/privacy implications
- Test coverage and missing tests
- Consistency with existing patterns
</instructions>

<manifest>
{{MANIFEST}}
</manifest>
<!-- CTX:END -->
```

### 20.4 Default `context` template

```md
<!-- CTX:BEGIN -->
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
<!-- CTX:END -->
```

---

## 21) Deterministic tool output formats (exact truncation rules)

These rules prevent “slightly different outputs” from cascading into different selections.

### 21.1 `file_search` result format

Tool result payload shape:

```json
{
  "pattern": "OAuth",
  "mode": "content",
  "results": [
    {
      "path": "src/auth/login.ts",
      "hits": 12,
      "top_excerpts": [
        {"line": 42, "excerpt": "…", "match": "OAuth"},
        {"line": 118, "excerpt": "…", "match": "OAuth"}
      ]
    }
  ],
  "truncation": {
    "max_files": 50,
    "max_excerpts_per_file": 3,
    "max_excerpt_chars": 200
  }
}
```

Deterministic constraints:

* results sorted by:

  1. descending hit count
  2. ascending path
* excerpts per file:

  * choose earliest line numbers among top hits
  * truncate excerpt to `max_excerpt_chars`, replacing overflow with `…`
* hard cap `max_files` (default 50 unless specified)
* include `truncation` object always

### 21.2 `codemap` result format

Payload shape:

```json
{
  "paths": ["src/auth/login.ts"],
  "detail": "summary",
  "results": [
    {
      "path": "src/auth/login.ts",
      "language": "typescript",
      "lines": 247,
      "symbols": [
        {"kind":"function","signature":"export async function login(req: Request, res: Response): Promise<void>","line":34},
        {"kind":"class","signature":"export class AuthService { ... }","line":88}
      ],
      "truncation": {
        "max_symbols": 200,
        "max_signature_chars": 160
      }
    }
  ]
}
```

Deterministic constraints:

* symbols sorted by ascending line number, then signature
* signature truncated to `max_signature_chars`
* `max_symbols` enforced per file
* if directory path provided:

  * return aggregated results with each file as an entry, but cap total files returned (`max_results`)
  * stable file ordering by path

### 21.3 `read_file` format

* Always line-numbered when enabled:

  * `0001| ...`
* Always end lines with `\n`
* If truncated by `limit`:

  * include a footer marker:

    * `... ‹TRUNCATED: limit=N›`

