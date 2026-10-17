# Pending improvements (feedback from a real session, 2026-10-17)

Source: a manager session that built a small Python project through the MCP using `researcher`, `coder`,
`reviewer` and `tester` (models `nan/deepseek-v4-flash` and `nan/glm5.3-flash`). Most items of the
original list are done (see CHANGELOG and "Done" below); the rest is pending.

## Done

- `send_message` had no `timeout` argument: a correction round was aborted by `AGENT_TIMEOUT` after 10 minutes. Added.
- `get_diff` returned an unhelpful `DIFF_UNAVAILABLE` in a directory that is not a git repo. The message now explains it.

- `get_diff` git fallback implemented (baseline stored on the session at creation; also feeds `files_changed`). Another
  session confirmed that OpenCode's `/diff` is empty even inside a git repo after the agent edits files, so the
  `files_changed` of 0 was not (only) a non-git problem.

- Default `cwd` documented in the tool descriptions and README (behaviour unchanged).

- `files_changed` in a git repo verified: the real-OpenCode E2E (12 tests, git repo) asserts `files_changed >= 1`. Passes.
- `get_session` now reports `opencode.last_activity_at`, `idle_ms` and `last_activity` (from the newest message/part
  timestamps of the live session), so a long run can be told apart from a stuck one.

## Pending

1. **Coder latency.** `nan/glm5.3-flash` took 6.6 minutes for a first round and over 10 for a combined design + tests
   round. This is the model, not the bridge. Try `nan/deepseek-v4-flash` or `nan/qwen3.8-flash` for `coder`, and tell
   users to split long work into short rounds.

## Observations (no action)

- The reviewer and tester (1.5-2.5 min) found data-loss defects the coder had reported as fine; the
  coder -> reviewer + tester loop is worth documenting as the recommended workflow.
- Tasks that run longer than 120 s go to the background and notify on completion: worked as intended.
