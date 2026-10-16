# Migration to the OpenCode v2 HTTP API

`claude-opencode-mcp-v2` talks to OpenCode 2.x (tested spec: 2.0.22) through its
`/api/*` HTTP surface with a small hand-written `fetch` client. `@opencode-ai/sdk`
and the optional `opencode-ai` dependency are gone. The MCP tool surface
(`delegate_task`, `create_session`, `send_message`, `get_session`, `get_diff`,
`abort_session`, `list_agents`) is unchanged.

Source of truth: `research/FINDINGS.md` and `research/opencode-v2-openapi.json`.

## What changed

| Area | v1 | v2 |
| --- | --- | --- |
| Client | `@opencode-ai/sdk` | `src/opencode/client.ts` (`OpenCodeClient`) + hand-written types in `src/opencode/api-types.ts` |
| Servers | one `opencode serve` per workspace, LRU (`maxServers`) | **one** server for all workspaces; the workspace goes in `location.directory` of `POST /api/session` |
| Health | `GET /global/health` | `GET /api/info` |
| Auth | Basic, user `opencode` | same; 401 is mapped to `OPENCODE_UNAVAILABLE` |
| Completion | poll `session.status` + messages | SSE `session.execution.*`, fallback polling `GET /api/session/active` and the final `{type:"idle", outcome}` message |
| Cancel | `session.abort` | `POST /api/session/{id}/interrupt` (idempotent) |
| Diff | git baseline at session creation | `GET /api/session/{id}/diff` |
| Permissions | agent `permission` config object | session `permissions` ruleset `[{action,resource,effect}]` derived from `src/security/policy.ts` (`toPermissionRuleset`) |
| Permission asks | SSE `permission.updated` + `/session/:id/permissions/:id` | SSE `permission.asked` + polling `GET /api/session/{id}/permission`, reply `POST .../permission/{req}/reply {decision:"reject"}` |
| Model ref | `{providerID, modelID}` | `{id, providerID, variant?}` |
| Default model | `config.providers().default` | `GET /api/model/default` / `GET /api/model` |

### Client rules
- Every non-streaming response must be `application/json` (or 204). OpenCode 2
  answers removed v1 routes with its SPA HTML and HTTP 200; the client turns that
  into `OPENCODE_ERROR` instead of silently accepting it.
- Responses are unwrapped from `{data, location?}` envelopes.
- Never call or log `GET /api/config` (it returns API keys in clear).

### Manager (`src/opencode/manager.ts`)
- With `opencode.url` it connects to an external server (URL credentials, config
  or `OPENCODE_SERVER_USERNAME/PASSWORD`; username defaults to `opencode`).
- Otherwise it spawns `opencode serve` once (cwd of the first workspace), with
  `OPENCODE_CONFIG_CONTENT` carrying the agents under the `agents` key
  (`system`, `permissions`, `model`). `OPENCODE_SERVER_PASSWORD` is set when a
  password is configured. Windows `.cmd` shims are spawned through a shell.
- `maxServers` is still accepted in the config but ignored.
- No more per-agent-set restarts: agents known when the server was spawned are
  the ones it has.

### Run lifecycle (`src/opencode/run.ts`, `src/mcp/execute.ts`)
1. Validate model (`GET /api/model`) and resolve the agent (`GET /api/agent/{id}`)
   before creating anything, because `POST /api/session` validates neither.
2. `POST /api/session` with `agent`, `model`, `location.directory`, `permissions`;
   the reported location is compared with the workspace (`WORKSPACE_MISMATCH`).
3. Before each prompt, `PATCH /api/session/{id}` (permissions) and
   `POST /api/session/{id}/agent` re-sync the permission variant, so
   `allow_edits` / `allow_bash` overrides on `send_message` keep working.
4. Open `GET /api/event`, then `POST /api/session/{id}/prompt`.
5. Done on `session.execution.<not started>` for the session, or when the session
   leaves `/api/session/active` after being seen running, or when an `idle`
   message newer than the user message exists. The `idle.outcome`
   (`succeeded|failed|interrupted`) decides the result; the summary is the last
   assistant message with text.
6. Timeout/abort call `interrupt`; 5 consecutive poll failures raise
   `OPENCODE_UNAVAILABLE`.

### Removed / reduced
- `util/git.ts` is kept only for workspace validation (git root); the baseline
  and `diffSinceBaseline` flow is no longer used. `AgentSession.baseline` and
  `DiffResult.source: "git"` are gone.
- External servers are no longer required to contain all bridge agents (see below).

## Custom agents (`agents/*.md`)
Isolated in `src/opencode/agents.ts` (`toOpenCodeAgentConfig`, `resolveSessionAgent`).
- Spawned server: every agent and its four permission variants are injected via
  `OPENCODE_CONFIG_CONTENT` (`agents.<name>`), as verified in the research.
- External server or agent unknown to the server: the session runs on the
  default agent and the agent's system prompt is prepended to each prompt.
- TODO(v2-agents): project agents (`.claude-opencode/agents`) discovered after the
  server started are not visible to it (a single server serves all workspaces);
  they currently use the prompt-preamble fallback. Options: `.opencode/agents/`
  discovery with `POST /api/location/reload`, or restart on change.

## Known gaps / TODO
- The exact SSE name/payload of a failed execution and the error detail of a
  failed run are not known; failures surface as `AGENT_EXECUTION_FAILED` with the
  `error` of the last assistant/idle message when present.
- Permission rule precedence (last match wins) is assumed, not verified.
- Asks are rejected, not prevented: unmatched actions fall back to OpenCode's
  default `ask`, which the watcher rejects.
- `get_session`, `get_diff` and `abort_session` need a connected server (as in v1:
  they do not start one).
- Not exercised against a real server in this change (no `OC_PW`); only the
  fake server in `tests/helpers/fake-opencode.ts` (which also serves HTML for v1
  routes and supports Basic auth).
- `tests/e2e/*` were not adapted or run; they target a real OpenCode.
- Integration tests that spawn a POSIX shell script as fake `opencode` are
  skipped on Windows.

## Agent names (no `deepseek-` prefix)
Built-in agents are now `researcher`, `reviewer`, `coder` and `tester` (files in `agents/`). The MCP only exposes
these plus project agents from `.claude-opencode/agents`; every other OpenCode agent (global ones such as
`architect`, `design/*`, `build`) is unreachable through `delegate_task` (`AGENT_NOT_FOUND`).
The old names (`deepseek-coder`, `deepseek-coder__rw`, ...) are still accepted and normalized, so existing
configs with `defaults.agent: "deepseek-researcher"` keep working.

Caveat: names are generic, so they can collide with agents of the same name in an OpenCode server the bridge did not
spawn (`opencode.url`). If the server already has e.g. its own `reviewer`, that one is used (with its own system prompt)
instead of the bridge definition; permissions still come from the per-session ruleset. A server the bridge spawns itself
is safe: its inline config overrides global agents of the same name.
