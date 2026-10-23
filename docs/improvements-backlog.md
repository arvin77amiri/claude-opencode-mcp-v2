# Improvement backlog (2026-10-18)

Improvements identified while reviewing `2.0.0-alpha.3` and packaging it as a Claude Code plugin.
Already done in that pass (see CHANGELOG, Unreleased): the plugin and marketplace, the
`opencode-delegation` skill, the stale "DeepSeek by default" descriptions, and stronger server
instructions.

The items are ordered roughly by value for the orchestrator relative to effort.

## 1. Richer run results

### 1.1 `files_changed` as a list of paths — done
- **Why:** today it is a number. Claude has to call `get_diff` just to know *which* files changed,
  even when deciding whether a review is needed.
- **How:** `countChangedFiles` (`src/mcp/execute.ts`) already has the entries (OpenCode diff or
  git fallback). Return `files_changed: [{ file, status, additions, deletions }]`, or keep the number
  and add `changed_files`, to avoid breaking clients. Update `DelegateResult`, the tool descriptions,
  the README and the skill.
- **Effort:** small.

### 1.2 Structured `## Changes` and `## Verification` for the coder
- **Why:** only `## Findings` / `## Root Causes` are parsed. A coder whose `npm test` failed reports it
  only in prose, so the orchestrator can miss it.
- **How:** reuse `sectionsFromMarkdown` (`src/util/text.ts`) and add `extractVerification` →
  `[{ command, passed: boolean | null, output }]` and `extractChanges` → `[{ file, note }]`. Expose
  them as `verification` / `changes` in the result. Do the same for the tester's `## Test Results`.
- **Effort:** small to medium (parsing plus tests on real samples in `research/smoke/`).

### 1.3 Tokens and cost per run — done
- **Why:** lets Claude pick models and avoid delegating trivial work. `api-types.ts` already has
  `cost` on assistant messages.
- **How:** add up `cost` and tokens over the run's assistant messages in `runPrompt` and return
  `usage: { cost, input_tokens, output_tokens }`. Also store it on the session for `get_session`.
- **Effort:** small.

## 2. Orchestration

### 2.1 Asynchronous mode — done
- **Why:** real fan-out (reviewer + tester in parallel, several researchers) depends today on Claude Code
  moving the call to the background after 2 minutes. An explicit asynchronous mode is more predictable
  and does not hold tool-call slots.
- **How:** `delegate_task` / `send_message` with `background: true` returns `{ session_id,
  status: "running" }` immediately and the run continues in the bridge. Add `wait_session
  { session_id, timeout }`, which blocks until the run finishes and returns the same `DelegateResult`.
  Keep the result in memory/registry until it is read.
- **Effort:** medium (lifecycle, cancellation on shutdown, tests).

### 2.2 Concurrent-editor guard — done
- **Why:** two sessions with edits on the same `cwd` overwrite each other, and the git-baseline diff then
  blames one for the other's changes. Today only the skill warns about it.
- **How:** in `executeRun`, keep a map `cwd → running session with canEdit`. If another editing run
  starts on the same canonical `cwd`, fail with a new `WORKSPACE_BUSY` code (with the session id), or
  wait/queue it with an opt-in flag.
- **Effort:** small.

### 2.3 Optional worktree isolation
- **Why:** lets a coder work without touching the tree Claude and the user are editing, and makes
  several coders in parallel possible.
- **How:** `isolation: "worktree"` on `create_session` / `delegate_task`: `git worktree add` into
  `.claude-opencode/worktrees/<session>` on a temporary branch, run the session there, `get_diff` against
  the fork point, and an `apply_session` / `discard_session` tool to merge or remove it. Requires git.
- **Effort:** large.

## 3. Visibility

### 3.1 Transcript of what the agent did
- **Why:** the summary is the agent's own account. Seeing the actual tool calls (commands run, files
  read and written) is the way to check "I ran the tests".
- **How:** `get_transcript { session_id, limit }`, or `verbose: true` on `get_session`, which returns
  the latest messages with their tool parts in compact form (tool name, input, short output, status).
  The data is already fetched with `client.messages`.
- **Effort:** small to medium.

### 3.2 `list_models`
- **Why:** Claude can't pick a valid `provider/model` without the user running `opencode models`.
- **How:** a read-only tool that returns `client.models()` (id, provider, display name), plus the model
  configured for each agent and the OpenCode default.
- **Effort:** small.

## 4. Claude Code integration

### 4.1 MCP prompts as slash commands
- **Why:** `registerPrompt` shows up in Claude Code as `/mcp__opencode__<name>` (or the plugin
  equivalent), so the user can run a ready-made workflow.
- **How:** prompts like `implement-and-review` (args: task), `review-diff` and `investigate`, whose
  content is the steps of the skill workflow. Alternatively, ship them as plugin `commands/`.
- **Effort:** small.

### 4.2 Evals for the skill
- **Why:** to check that the skill really changes the behaviour (passing `cwd`, using `get_diff`, not
  running two coders in parallel) and to catch regressions when it is edited.
- **How:** `evals/` with `claude plugin eval` cases. Example: "add input validation to X and make sure
  it works", graded on whether Claude passes `cwd`, writes a self-contained brief, calls `get_diff`,
  and runs reviewer/tester. A real MCP is opt-in; start with a fake server
  (`tests/helpers/fake-opencode-serve.mjs`).
- **Effort:** medium.

### 4.3 Keep the plugin version in sync
- **Why:** `.claude-plugin/plugin.json` has `version` duplicated from `package.json`.
- **How:** a check in CI (or in the release script) that compares the two, and `claude plugin tag` when
  publishing.
- **Effort:** small.

## 5. Housekeeping

- **The docs describe `init` as detecting DeepSeek**, while `src/cli/init.ts` already accepts any
  provider listed by `opencode models`: `docs/installation.md` ("detects … the DeepSeek provider",
  "Choose DeepSeek and paste an API key") and `docs/troubleshooting.md` ("DeepSeek is not detected by
  `init`"). Rewrite them in provider-neutral terms.
- **Docs audit for v2:** `docs/development.md` and `docs/security-audit.md` still describe the E2E
  tests as "OpenCode/DeepSeek" and use `deepseek/deepseek-flash` as the example model. Review all of
  `docs/` against the README.
- **README badges** point to `putuandy/claude-opencode-mcp`, not to this repository.
- **`npm audit`** reported 2 high-severity vulnerabilities in dependencies (E2E report of 2026-10-17),
  not investigated.
- **`biome.json`**: the schema is 2.5.14 and the installed Biome is 2.5.15 (`biome migrate`).
- **E2E workflow test:** per-step logging/timeout so a timeout identifies the stuck agent (suggested
  in `docs/e2e-report-2026-10-17.md`).
