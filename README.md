# ctx

**AI-powered context builder for LLM prompts.**

`ctx` takes a task description and a code repository, uses an AI agent to explore the codebase, and outputs a single paste-ready prompt with token-budgeted, high-signal context. The prompt is ready to feed into any reasoning model — Claude, GPT, Gemini, or others.

```bash
ctx "Add GitHub OAuth login and integrate it into the existing auth flow"
```

A discovery agent (powered by OpenAI, Anthropic, Google, or a local CLI like Claude Code) searches your repo, reads files, inspects symbol maps, and assembles the best possible context — all within a hard token budget. **stdout** gets the prompt. **stderr** gets progress and a token report.

## Why ctx?

When asking an LLM to work on a codebase, you need to give it the right files, the right slices of those files, and enough structural context to reason well — but not so much that you blow the context window or drown signal in noise. Manually copying files is tedious and error-prone. Including everything is wasteful and noisy.

`ctx` solves this by dispatching an AI discovery agent that:

- **Explores your codebase intelligently** — the agent searches, reads, and follows import chains to find exactly what's relevant, using a sandboxed tool-calling loop with 14 specialized tools
- **Stays within budget** — token enforcement with intelligent degradation (full file → slices → codemap → drop) ensures the output always fits
- **Explains its decisions** — every included file has a rationale; every dropped file has a reason
- **Falls back gracefully** — if no LLM is available, a deterministic offline ranker using task-term extraction, symbol indexing, and entrypoint heuristics takes over

## Install

### Binary install (curl)

Install the latest release binary:

```bash
curl -fsSL https://raw.githubusercontent.com/neilpattanaik/ctx/main/scripts/install.sh | bash
```

Install a specific release tag:

```bash
CTX_VERSION=v0.2.2 curl -fsSL https://raw.githubusercontent.com/neilpattanaik/ctx/main/scripts/install.sh | bash
```

Install to a custom directory:

```bash
CTX_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://raw.githubusercontent.com/neilpattanaik/ctx/main/scripts/install.sh | bash
```

Release binaries are published for:
- Linux x64 (`ctx-linux-x64.tar.gz`)
- macOS ARM64 / Apple Silicon (`ctx-macos-arm64.tar.gz`)
- macOS x64 / Intel (`ctx-macos-x64.tar.gz`)
- Windows x64 (`ctx-windows-x64.zip`)

### Release workflow

GitHub Actions now publishes release binaries automatically for all four platforms.

```bash
git tag v0.3.0
git push origin v0.3.0
```

This triggers `.github/workflows/release.yml`, which builds each platform binary,
uploads release assets, and attaches `ctx-checksums.txt` with SHA256 checksums.

You can also run the workflow manually with `workflow_dispatch` and provide a tag.

### Build from source

Requires [Bun](https://bun.sh) v1.0+.

```bash
git clone <repo-url> && cd ctx
bun install
bun run build
```

The built CLI is at `dist/ctx.js`. Link it for convenience:

```bash
bun link    # makes `ctx` available globally
```

Or run directly:

```bash
bun run src/index.ts "your task here"
```

### External dependencies

- **ripgrep** (`rg`) — used for fast content search. Falls back to a slower built-in search if unavailable.
- **git** — required for git integration features (diff, status, repo root detection).
- **tree-sitter** — bundled via `web-tree-sitter` WASM; no native install needed.

## Quick start

```bash
# Plan mode (default) — an agent explores your repo and builds a planning prompt
ctx "Refactor the authentication module to use JWT"

# Specify which LLM powers discovery
ctx "Add rate limiting" --agent anthropic --model claude-sonnet-4-20250514

# Use your local Claude CLI as the discovery agent
ctx "Fix the login redirect bug" --agent claude-cli

# Question mode — agent finds the relevant code, prompt asks for explanation
ctx "How does the caching layer work?" --mode question

# Review mode — agent gathers diff context for a code review prompt
ctx "Review my recent changes" --mode review --diff uncommitted

# Context mode — raw curated context, minimal instructions
ctx "Payment processing flow" --mode context

# Save to file or copy to clipboard
ctx "Add rate limiting to the API" -o prompt.md
ctx "Fix the login redirect bug" --copy

# Pipe a multiline task
cat task.md | ctx

# Offline mode (no LLM calls — fast deterministic ranking)
ctx "Migrate database schema" --no-llm

# Airgap mode (strict privacy, fully local)
ctx "Audit secrets handling" --privacy airgap
```

## Modes

| Mode | Purpose | Key sections |
|------|---------|-------------|
| `plan` | Architecture and implementation planning | Task, questions, handoff summary, codemaps, files, instructions for a structured plan |
| `question` | Understanding and investigation | Task, codemaps, files, instructions to explain with file/line references |
| `review` | Code review | Git diff prominently placed, surrounding context, instructions for severity-grouped findings |
| `context` | Pure context delivery | Files, codemaps, tree — minimal instructions, maximum content |

## How it works

`ctx` runs a staged pipeline: scan the repo, build an index, dispatch a discovery agent, enforce budget constraints, assemble the prompt.

```
Task text + flags
       │
       ▼
┌─────────────────┐
│  Config merge    │  CLI flags > env vars > repo .ctx/config.toml > user config > defaults
└────────┬────────┘
         ▼
┌─────────────────┐
│  Repo scan       │  Walk files, respect .gitignore, detect binaries, enforce size limits
└────────┬────────┘
         ▼
┌─────────────────┐
│  Index update    │  Incremental SQLite index: files, symbols, imports
└────────┬────────┘
         ▼
┌─────────────────┐
│  Discovery       │  AI agent explores the repo via tool-calling (or offline fallback)
└────────┬────────┘
         ▼
┌─────────────────┐
│  Selection       │  Enforce constraints, normalize budget, apply degradation
└────────┬────────┘
         ▼
┌─────────────────┐
│  Prompt assembly │  Template + sections (tree, codemaps, files, diff, metadata)
└────────┬────────┘
         ▼
┌─────────────────┐
│  Output          │  stdout/file/clipboard + artifacts in .ctx/runs/
└─────────────────┘
```

### Discovery: the agentic core

The heart of `ctx` is its discovery agent — an LLM that explores your codebase through a sandboxed tool-calling loop. The agent has access to 14 tools:

| Category | Tools |
|----------|-------|
| Navigation | `repo_info`, `file_tree`, `list_files` |
| Search & read | `file_search` (ripgrep), `read_file`, `read_snippet` |
| Code structure | `codemap` (tree-sitter symbol extraction) |
| Git | `git_status`, `git_diff` |
| Selection | `select_add`, `select_remove`, `select_get`, `select_clear` |
| Budget | `token_estimate`, `budget_report` |

The agent searches for relevant code, reads files to confirm relevance, inspects symbol maps for structural context, follows import chains, and builds a curated selection — all while tracking its token budget. When it's done, it outputs a structured result with the selection, a handoff summary (entrypoints, key modules, data flows), and open questions for the reasoning model.

**Guardrails**: Even if the agent misbehaves, `ctx` enforces ignore/never-include rules, file size limits, max file counts, and deterministic budget normalization *after* the agent finishes. The agent is a proposer; `ctx` is the enforcer.

### Discovery backends

**Auto** (default) — Automatically selects the best available backend:

1. **LLM via provider API** — OpenAI, Anthropic, or Google. Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY` and `ctx` will use the corresponding provider for agent discovery.
2. **LLM via local CLI** — Adapters for Claude CLI (`claude`), Codex CLI (`codex`), and Gemini CLI (`gemini`). Same tool protocol and enforcement as API-based discovery. Use `--agent claude-cli` to target a specific CLI.
3. **Offline deterministic** — Falls back here if no LLM is available, or when explicitly requested with `--no-llm`. Extracts task terms, queries the index, scores files by term hits + import proximity + entrypoint heuristics + git bias. Fully deterministic, no external calls.

### Token budgeting

Every `ctx` run enforces a hard token budget (default: 60,000 tokens). When the selection exceeds the budget, `ctx` applies a deterministic degradation ladder:

1. Reduce codemap detail (complete → summary)
2. Reduce slice context lines
3. Degrade full files → slices
4. Drop lowest-priority files

Every degradation is recorded in the token report with a reason. The output prompt always includes a token report showing budget, estimated usage, per-section breakdown, and any degradations applied.

## CLI reference

```
ctx [TASK_TEXT] [flags]          # Main command
ctx init                         # Create .ctx/config.toml
ctx index [--rebuild]            # Manage the SQLite index
ctx templates list               # List available templates
ctx templates show <name>        # Show a template
ctx explain [last|<run-id>]      # Why was each file included?
ctx manifest [last|<run-id>]     # Export selection manifest
ctx open [last|<run-id>]         # Open generated prompt in $PAGER
```

### Flags

#### Mode and output

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `plan` | `plan`, `question`, `review`, or `context` |
| `--format` | `markdown+xmltags` | `markdown`, `markdown+xmltags`, `xml`, or `plain` |
| `-o, --output` | stdout | Write prompt to file |
| `--copy` | off | Copy prompt to clipboard |
| `--quiet` | off | Suppress stderr output |
| `--verbose` | off | Include discovery transcript + timings in artifacts |
| `--json-summary` | off | Machine-readable run summary to stderr |
| `--dry-run` | off | Run discovery but don't output a prompt |

#### Budget and limits

| Flag | Default | Description |
|------|---------|-------------|
| `--budget` | `60000` | Token budget for the output prompt |
| `--reserve` | `15000` | Warning threshold for remaining tokens |
| `--max-files` | `80` | Maximum files in selection |
| `--max-full-files` | `10` | Maximum files included in full |
| `--max-slices-per-file` | `4` | Maximum slices per file |
| `--max-file-bytes` | `1500000` | Skip files larger than this |
| `--fail-on-overbudget` | off | Exit with error if budget is exceeded |

#### Discovery

| Flag | Default | Description |
|------|---------|-------------|
| `--discover` | `auto` | `auto`, `llm`, `local-cli`, or `offline` |
| `--agent` | — | Override discovery agent (e.g., `claude-cli`, `codex-cli`) |
| `--model` | — | Model name for LLM discovery |
| `--agent-timeout` | `600` | Discovery timeout in seconds |
| `--agent-max-turns` | `20` | Max tool-calling turns for LLM discovery |
| `--no-llm` | off | Force offline deterministic discovery |

#### Context shaping

| Flag | Default | Description |
|------|---------|-------------|
| `--tree` | `auto` | File tree: `auto`, `full`, `selected`, or `none` |
| `--codemaps` | `auto` | Symbol maps: `auto`, `selected`, `none`, or `complete` |
| `--line-numbers` | `on` | Include line numbers in file content |
| `--include` | — | Include glob pattern (repeatable) |
| `--exclude` | — | Exclude glob pattern (repeatable) |
| `--prefer-full` | — | Prefer full inclusion for matching files (repeatable) |
| `--prefer-slices` | — | Prefer slice inclusion for matching files (repeatable) |
| `--prefer-codemap` | — | Prefer codemap-only for matching files (repeatable) |
| `--entrypoint` | — | Mark path as an entrypoint (repeatable) |

#### Git integration

| Flag | Default | Description |
|------|---------|-------------|
| `--diff` | `off` | `off`, `uncommitted`, `staged`, `unstaged`, `main`, `compare:<ref>`, `back:<N>` |
| `--git-status` | `on` | Include git status in output |
| `--git-max-files` | `20` | Max files in diff |
| `--git-max-patch-tokens` | `6000` | Token budget for diff patches |

#### Privacy and redaction

| Flag | Default | Description |
|------|---------|-------------|
| `--privacy` | `normal` | `normal`, `strict`, or `airgap` |
| `--redact` | `on` | Redact detected secrets |
| `--redact-pattern` | — | Extra regex for redaction (repeatable) |
| `--never-include` | — | Glob patterns that cannot be overridden by discovery (repeatable) |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Invalid usage |
| `3` | Repo not found / no readable files |
| `4` | Index error |
| `5` | Discovery backend failure (may still output via fallback) |
| `6` | Prompt render failure |
| `7` | Output failure (file/clipboard) |

## Configuration

Configuration merges from multiple sources (highest priority first):

1. **CLI flags**
2. **Environment variables** (`CTX_BUDGET`, `CTX_MODE`, `CTX_FORMAT`, `CTX_DISCOVER`, etc.)
3. **Repo config** — `.ctx/config.toml` in the repository root
4. **User config** — `~/.config/ctx/config.toml`
5. **Built-in defaults**

Run `ctx init` to generate a `.ctx/config.toml` with defaults.

### Example config

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
engine = "sqlite"
rebuild_on_schema_change = true

[discovery]
discover = "auto"
provider = "openai"
model = ""
timeout_seconds = 600
max_turns = 20

[local_cli]
agent_priority = ["codex-cli", "claude-cli", "gemini-cli"]

[git]
diff = "off"
git_status = true
max_files = 20
max_patch_tokens = 6000

[privacy]
mode = "normal"
redact = true
never_include = ["**/.env", "**/*secret*", "**/*private_key*"]

[output]
include_manifest_footer = true
include_token_report = true
path_display = "relative"
store_runs = true
runs_dir = ".ctx/runs"
```

## Privacy modes

| Mode | Behavior |
|------|----------|
| `normal` | Selective redaction of known secret patterns (AWS keys, API tokens, private keys, passwords). LLM discovery allowed. |
| `strict` | Aggressive entropy-based redaction in addition to pattern matching. LLM discovery allowed but content is more heavily filtered. |
| `airgap` | Forces offline discovery. No external API calls. All analysis is local. |

Secret detection uses both regex patterns (AWS `AKIA...`, Stripe `sk_live_...`, private key headers, etc.) and entropy analysis. Detected secrets are replaced with `‹REDACTED:category›` markers.

The `--never-include` flag provides hard exclusion that cannot be overridden by any discovery backend — use it for sensitive files.

## Code analysis

### Tree-sitter parsing

`ctx` uses tree-sitter (via WASM) to extract symbol maps from source files. These codemaps give the reasoning model a structural overview without including full file contents.

**Supported languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, Ruby, Swift, Kotlin, C#

**Extracted symbols:** functions, classes, interfaces, types, enums, methods, modules, variables — with signatures and line ranges.

### SQLite index

An incremental SQLite index tracks:
- **Files** — path, size, mtime, content hash, language, line count
- **Symbols** — kind, name, signature, line range (from tree-sitter)
- **Imports** — dependency graph between files

The index enables fast task-term matching, import-graph traversal, and symbol lookup. It updates incrementally — only re-indexing files whose content hash has changed.

### Offline fallback ranking

When no LLM is available (or with `--no-llm`), `ctx` uses a deterministic scoring algorithm:

1. **Content term hits** — weighted by term category (identifiers: 10, search terms: 6, paths: 14)
2. **Breadth bonus** — 6 points per unique matched term
3. **Import proximity** — transitive dependency boost (factor 0.2)
4. **Entrypoint score** — heuristic detection of main files, routes, CLI entries, config (up to 120 points)
5. **Git bias** — boost recently-changed files when in review mode

## Templates

`ctx` ships with four built-in prompt templates corresponding to the four modes. Each template defines the section order and mode-specific instructions for the reasoning model.

Custom templates can be placed in `.ctx/templates/` as Markdown files with optional YAML frontmatter:

```markdown
---
name: security-audit
description: Security-focused review template
---
<!-- CTX:BEGIN -->
<task>
{{TASK}}
</task>
<files>
{{FILES}}
</files>
<instructions>
Perform a security audit focused on OWASP Top 10...
</instructions>
<!-- CTX:END -->
```

Available template variables: `{{TASK}}`, `{{REPO_ROOT}}`, `{{RUN_ID}}`, `{{BUDGET_TOKENS}}`, `{{PROMPT_TOKENS_ESTIMATE}}`, `{{TREE}}`, `{{CODEMAPS}}`, `{{FILES}}`, `{{GIT_DIFF}}`, `{{REPO_OVERVIEW}}`, `{{OPEN_QUESTIONS}}`, `{{HANDOFF_SUMMARY}}`, `{{TOKEN_REPORT}}`, `{{MANIFEST}}`, and more.

## Inspection and reproducibility

Every run produces artifacts in `.ctx/runs/<run-id>/`:

- **`run-record.json`** — Full metadata: config, discovery results, selection, token report, timing
- **`manifest.json`** — What was selected and why
- **`explain.json`** — Per-file inclusion rationale

Use the inspection subcommands:

```bash
# Why was each file included or dropped?
ctx explain last

# Export the selection manifest
ctx manifest last -o manifest.json

# Open the generated prompt in your pager
ctx open last
```

## Architecture

```
src/
├── cli/               # Argument parsing, command routing, pipeline orchestration
├── types/             # Core type definitions and contracts
├── config/            # TOML parsing, config merging, env var overrides
├── scanner/           # File walking, gitignore, binary detection, size limits
├── index-manager/     # SQLite index: schema, incremental updates, import extraction
├── search/            # Ripgrep integration with fallback
├── codemap/           # Tree-sitter parsing, symbol extraction, caching
├── discovery/         # Offline ranking + LLM adapters (OpenAI, Anthropic, Google, CLIs)
├── selection/         # Budget enforcement, priority tiers, degradation ladder
├── prompt/            # Templates, section renderers, output formatters
├── git/               # Git runner, diff parsing, status collection
├── privacy/           # Secret detection, entropy analysis, redaction
├── tools/             # Tool host for agent discovery (14 tools)
├── artifacts/         # Run persistence, manifest generation, explain reports
└── utils/             # Token estimation, deterministic helpers, path utilities
```

## Development

```bash
# Run from source
bun run dev "your task"

# Run tests
bun test                    # All tests
bun run test:unit           # Unit tests
bun run test:integration    # Integration tests
bun run test:e2e            # End-to-end tests

# Build
bun run build

# Benchmark
bun run benchmark
```

## License

Private — see repository for details.
