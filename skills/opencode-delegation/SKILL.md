---
name: opencode-delegation
description: How to orchestrate OpenCode agents through the opencode MCP server (delegate_task, create_session, send_message, get_session, get_diff, abort_session, list_agents). Use it before delegating work to the researcher, coder, reviewer or tester agents, when planning a multi-agent workflow, when checking what a delegated agent changed, and when one of those tools returns an error or times out.
---

# Orchestrating OpenCode agents

You are the orchestrator. The opencode MCP server runs OpenCode agents **in the same working tree you
are using**, on whatever model the user configured. The agents do the exploring, editing and test
running; you split the work, write the briefs, check the results and report to the user.

The tool names below are short. Depending on how the server was installed they show up as
`mcp__opencode__delegate_task`, `mcp__plugin_opencode-bridge_opencode__delegate_task`, or similar.

## 1. Decide whether to delegate

Delegate when the work is **large enough to pay for the latency** (a run usually takes 1-10 minutes)
or when you want an **independent second opinion**:

- exploring an unfamiliar repository or a wide area of it (`researcher`);
- implementing a well-defined change of moderate size (`coder`);
- reviewing a diff independently, especially one a `coder` wrote (`reviewer`);
- running a test suite and explaining the failures (`tester`);
- several independent read-only investigations at once.

Do it yourself when the change is small (a few lines, one file), when you already have the context
loaded, or when the user is waiting interactively for a quick answer.

## 2. Write a self-contained brief

The agent **does not see this conversation**. Everything it needs has to be in `task`. A vague brief
gets a vague result. Include:

1. **Goal**: what to achieve and why, in one or two sentences.
2. **Context**: what you already know (relevant files, functions, decisions the user made, what you
   ruled out). Pass the starting files as `paths` too; they are hints, not a boundary.
3. **Scope**: what to change and what to leave alone.
4. **Done when**: a checkable criterion, such as "`npm test` passes" or "a failing test for X now passes".
5. **Verification**: the exact command to run, if you know it.
6. **Output**: ask for the agent's standard format (each agent already has one; see below).

Ready-to-adapt briefs for each agent are in [references/task-templates.md](references/task-templates.md).

Always pass **`cwd`** as the absolute project root. Without it, the workspace falls back to
`CLAUDE_PROJECT_DIR` or the directory the bridge started in, which may be a parent directory. Check
the `cwd` the result returns.

## 3. Pick the agent and permissions

| Agent | Use for | Edits | Shell | Reply sections |
| --- | --- | --- | --- | --- |
| `researcher` | mapping code, dependencies, options | no | no | summary, findings |
| `reviewer` | bugs, regressions, security in a diff | no | no | `## Findings`, `## Verdict` |
| `coder` | implementing, refactoring, fixing | yes | yes | `## Changes`, `## Verification`, `## Follow-ups` |
| `tester` | running tests, root-causing failures | no | yes | `## Test Results`, `## Root Causes`, `## Suggested Fixes` |

- `allow_edits` / `allow_bash` change the defaults for one call (`true` grants, `false` revokes,
  omitted keeps the default). Grant only what the task needs. A `researcher` that needs to run a
  script gets `allow_bash: true`; it doesn't need to become a `coder`.
- Even with every grant, agents cannot edit `.env` or credential files and cannot `git commit` or
  `git push`. **Committing is your job**, and only when the user asks.
- `findings` in the result is parsed from bullets like
  `- [severity: high] Title (path/file.ts:42) — detail`. Read the `summary` too: anything not in that
  format only appears there.
- Each result has `usage` (cost in USD and tokens of that run; `get_session` gives the session
  total). Use it to notice when a small task is costing more than doing it yourself.
- `list_agents` shows project-specific agents (from `.claude-opencode/agents/`) and the model of each.
  Call it once if you are unsure what is available.

## 4. Recommended workflow

For a non-trivial change:

1. **researcher** (optional): map the area if you don't know it. Skip it if you already do.
2. **coder**: implement with a precise brief that includes the test command.
3. **get_diff** on the coder's session: read the actual changes. The run result's `changed_files`
   already lists which files changed (`files_changed` is the count); an empty list after a coder run
   that claims edits is a red flag.
4. **reviewer** and **tester** **in parallel**: give the reviewer the diff context (files, intent);
   give the tester the commands to run.
5. If they find real problems: `send_message` to the **same coder session** with the specific findings
   (it keeps its context), then repeat steps 3-4 on the new changes only.
6. Report to the user: what changed (from the diff), what was verified, and what remains open.

**Never trust a coder's self-report.** A coder will report work as "done, tests pass" even when an
independent reviewer or tester then finds data-loss bugs. The diff and an independent check are the
evidence; the coder's summary is not.

## 5. One-shot vs session

- `delegate_task`: a new session per call. Good for independent, single-round work.
- `create_session` + `send_message`: multi-round work where the agent should keep its context
  (implement, then fix review findings, then add tests). Permission overrides from `create_session`
  persist; `send_message` can change them from that message onward.
- **Prefer several short rounds to one huge task.** Big combined tasks ("design + implement + test
  everything") are the ones that hit `AGENT_TIMEOUT`. One concern per message.
- `delegate_task` also returns a `session_id`, so you can continue a one-shot run with `send_message`.

## 6. Parallelism rules

- Read-only agents (`researcher`, `reviewer`, and `tester` without edits) can run in parallel freely.
- **Never run two agents that can edit at the same time on the same `cwd`**: they share one working
  tree and will overwrite each other. Run them one after another. The bridge enforces this: the
  second editing run fails with `WORKSPACE_BUSY` (also for a parent or child directory).
- **Do not edit files yourself while a coder is running** in the same tree, for the same reason.
- `get_diff` falls back to a git diff against a baseline taken when the session was created. Files
  edited by anyone else (you, another agent) after that baseline also show up in it. Keep editors
  sequential so each diff is attributable.

## 7. Long runs, timeouts and stuck sessions

- Claude Code moves tool calls longer than about 2 minutes to the background and notifies you when
  they finish. That's normal; keep working on other things in the meantime.
- Raise `timeout` (milliseconds, up to 3,600,000) for big tasks, on `delegate_task` or `send_message`.
- To tell a slow run from a stuck one, call `get_session`: `opencode.status` (`busy`/`idle`/`retry`),
  `opencode.idle_ms` and `opencode.last_activity` show whether the agent is still doing things.
  If it has been idle for several minutes while `busy`, `abort_session` and retry with a narrower task.
- After an `AGENT_TIMEOUT`, the agent may have already made partial edits: call `get_diff` before
  retrying, so you don't start over on top of half-done work without knowing.

## 8. Errors

Errors come back as `isError: true` with `{ error: { code, message, details, retryable } }`.
A run can also finish with `status` `failed`/`timeout` and an `error` field.

| Code | What to do |
| --- | --- |
| `AGENT_TIMEOUT` | `get_diff` for partial work, then retry with a larger `timeout` or a smaller task. |
| `OPENCODE_ERROR` "Provider authentication failed" | Credentials missing or expired. Tell the user to run `opencode auth login`; don't retry. |
| `AGENT_EXECUTION_FAILED` "output length limit" | The task is too big for one reply. Split it, or ask for a shorter report. |
| `AGENT_EXECUTION_FAILED` (provider `APIError`) | Look at `details.statusCode` / `isRetryable`: rate limits and 5xx errors are worth one retry; a 4xx error isn't. |
| `AGENT_ABORTED` | Someone called `abort_session` or the call was cancelled. Don't retry unless the user asks. |
| `MODEL_NOT_AVAILABLE` | Use an exact `provider/model` id; ask the user which one (they can list them with `opencode models`). |
| `AGENT_NOT_FOUND` | Check `list_agents`. With an external OpenCode server the four agents must exist in its config. |
| `WORKSPACE_BUSY` | Another editing run is in progress on that tree (`details.busy_session_id`). Wait for it, or run this one read-only; don't abort the other run unless the user asks. |
| `WORKSPACE_NOT_FOUND` / `WORKSPACE_NOT_ALLOWED` / `WORKSPACE_MISMATCH` | Wrong or disallowed `cwd`. Pass the absolute project root; never retry with a different directory without asking. |
| `OPENCODE_NOT_AVAILABLE` / `OPENCODE_START_TIMEOUT` | OpenCode isn't installed or won't start. Tell the user; don't loop. |
| `OPENCODE_SESSION_NOT_FOUND` | The session is gone (pruned or server reset). Start a new one with the full brief. |
| `DIFF_UNAVAILABLE` / `NOT_GIT_REPOSITORY` | No diff is available outside git. Read the files the coder listed under `## Changes`. |
| `retryable: true` | One retry is reasonable. Otherwise, fix the cause first. |

## 9. Reporting to the user

- Say which agent and model did what (`agent` and `model` are in each result).
- Describe changes from `get_diff`, not from the agent's summary.
- State what was actually verified (which commands passed, which review findings were fixed) and what
  wasn't.
- Pass on high-severity findings you decided not to fix, with the reason.
