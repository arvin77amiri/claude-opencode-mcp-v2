# Configuration

The bridge reads JSON configuration from three layers, later layers overriding
earlier ones:

1. **Global**: `~/.config/claude-opencode-mcp/config.json`
   (`XDG_CONFIG_HOME` is honoured)
2. **Project**: `<workspace>/.claude-opencode/config.json`
3. **Explicit**: the file named by `CLAUDE_OPENCODE_CONFIG`

Layers are deep-merged, then defaults are applied once. Unknown keys are
ignored; wrong types produce a `CONFIG_INVALID` error that names the file and
the offending fields.

## Full reference

```json
{
  "opencode": {
    "url": null,
    "autoStart": true,
    "hostname": "127.0.0.1",
    "port": 0,
    "startupTimeout": 30000,
    "binary": null,
    "username": null,
    "password": null,
    "logLevel": null,
  },
  "workspace": {
    "allowedRoots": [],
    "defaultCwd": null
  },
  "defaults": {
    "agent": "researcher",
    "provider": null,
    "model": null
  },
  "timeouts": {
    "execution": 600000
  },
  "security": {
    "protectEnvFiles": true,
    "denyGitPush": true,
    "denyGitCommit": true,
    "externalDirectory": "deny",
    "extraProtectedPatterns": []
  },
  "limits": {
    "summaryChars": 16000,
    "sessionChars": 20000,
    "diffChars": 60000,
    "maxConcurrentRuns": 3
  },
  "agents": {
    "coder": {
      "model": "deepseek/deepseek-v4-pro",
      "temperature": 0.1
    }
  }
}
```

### `opencode`

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `null` | Connect to an existing OpenCode server instead of starting one. |
| `desktop` | `false` | Use the OpenCode Desktop background service; url and password come from its `service.json`. Overrides `url` and never starts an engine. See [below](#using-the-opencode-desktop-service). |
| `serviceFile` | `null` | Path of the Desktop `service.json` (default `$XDG_STATE_HOME/opencode/service.json`, else `~/.local/state/opencode/service.json`). |
| `autoStart` | `true` | Start a headless OpenCode server lazily on first use. |
| `hostname` | `127.0.0.1` | Bind address for the started server. |
| `port` | `0` | Port for the started server; `0` picks a free port. |
| `startupTimeout` | `30000` | Milliseconds to wait for "server listening". |
| `binary` | `null` | Explicit path to the OpenCode executable. |
| `username` / `password` | `null` | HTTP basic auth for the server. Falls back to `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`. |
| `logLevel` | `null` | `DEBUG`, `INFO`, `WARN` or `ERROR` passed to `opencode serve`. |
| `maxServers` | — | Obsolete in v2 (single shared server); accepted and ignored. |

> **Network exposure:** leave `hostname` at `127.0.0.1`. Binding the OpenCode
> server to a routable address exposes its HTTP API to your network; if you
> must, set `OPENCODE_SERVER_PASSWORD` and firewall the port. See
> [security.md](security.md#network-exposure).

### `workspace`

| Key | Default | Meaning |
| --- | --- | --- |
| `allowedRoots` | `[]` | When non-empty, every workspace must canonicalize inside one of these roots. |
| `defaultCwd` | `null` | Last-resort workspace when no explicit `cwd`, `CLAUDE_PROJECT_DIR` or process directory is usable. |

### `defaults`

| Key | Default | Meaning |
| --- | --- | --- |
| `agent` | `researcher` | Agent used when a tool call omits `agent`. |
| `provider` | `null` | Optional provider used to complete bare model ids. No provider is assumed: when `null`, a bare id is looked up in OpenCode's model catalog and must match exactly one provider. |
| `model` | `null` | `provider/model` or bare model id; `null` uses the default model of the user's own OpenCode. |

### `timeouts`

| Key | Default | Meaning |
| --- | --- | --- |
| `execution` | `600000` | Default per-run timeout in milliseconds. Tools may override with `timeout`. |

### `security`

| Key | Default | Meaning |
| --- | --- | --- |
| `protectEnvFiles` | `true` | Deny `read`/`edit` on `.env*`, keys, credentials and `.ssh/*` (examples stay readable). |
| `denyGitPush` | `true` | Deny shell commands matching `git push*`. |
| `denyGitCommit` | `true` | Deny shell commands matching `git commit*`. |
| `externalDirectory` | `deny` | Policy for paths outside the workspace: `allow`, `ask` or `deny`. `ask` is discouraged in headless mode. |
| `extraProtectedPatterns` | `[]` | Extra wildcard patterns to deny for read/edit, e.g. `secrets/*`. |

### `limits`

| Key | Default | Meaning |
| --- | --- | --- |
| `summaryChars` | `16000` | Maximum characters of agent output returned from a run. |
| `sessionChars` | `20000` | Maximum characters of the last summary returned by `get_session`. |
| `diffChars` | `60000` | Maximum characters returned by `get_diff`. |
| `maxConcurrentRuns` | `3` | Delegated runs executing at once, blocking and background together (1-32). Extra runs wait in a FIFO queue (`status: "queued"`) instead of failing. Read from the global config at bridge start. |

### `agents`

Per-agent overrides keyed by agent name:

```json
{
  "agents": {
    "coder": {
      "description": "Custom description",
      "model": "deepseek/deepseek-v4-pro",
      "temperature": 0.1,
      "prompt": "Custom prompt text",
      "profile": "code",
      "enabled": true
    }
  }
}
```

- `profile` selects the permission profile (`read`, `review`, `code`, `test`) —
  use it when adding a custom agent that is not one of the four built-ins.
- `enabled: false` removes an agent from `list_agents` and delegation.
- Project-local markdown files in `.claude-opencode/agents/` take precedence
  over built-in prompts; config `agents` overrides take precedence over both.

## Connecting to an existing OpenCode server

```json
{
  "opencode": {
    "url": "http://127.0.0.1:4096",
    "autoStart": false
  }
}
```

Start the server yourself:

```bash
opencode serve --port 4096
```

In external-server mode the bridge cannot inject agent definitions or
permissions. It calls `GET /agent` and refuses to delegate when the four
required agents are missing (`AGENT_NOT_FOUND`). Install them by copying the
files from `agents/` into `.opencode/agents/` in the project, or run
`claude-opencode init` and copy from `.claude-opencode/agents/`.

Credentials in the URL (`http://user:pass@host:port`) or in `username`/`password`
are sent as HTTP basic auth. Credentials from the environment are only used for
auto-started servers, never for external URLs.

## Using the OpenCode Desktop service

OpenCode Desktop (2.1+) runs one background `opencode-cli` service and writes how
to reach it to `~/.local/state/opencode/service.json` (`url`, `pid`, `password`, ...).
The port and password change on every app start, so do not copy them into
`opencode.url`. Instead:

```json
{
  "opencode": { "desktop": true }
}
```

- Before every run the bridge re-reads `service.json`. If the app was restarted
  (new port, password or pid) it reconnects transparently.
- If the app is closed (file missing, or its `pid` has exited) the call fails with
  `OPENCODE_UNAVAILABLE` and a hint to open OpenCode Desktop. The bridge never
  starts a second OpenCode engine in this mode, whatever `autoStart` says.
- The password is used only as HTTP basic auth and is never logged.
- As with any external server, install the bridge agents on it with
  `claude-opencode-v2 install-agents --global`; otherwise the server runs its
  default agent and only the per-session permission ruleset applies.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_BIN` | Path to the OpenCode executable. |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Basic auth for started or external servers. |
| `OPENCODE_CONFIG_CONTENT` | Inherited inline OpenCode config; merged with the bridge's agent definitions. |
| `CLAUDE_OPENCODE_CONFIG` | Extra config file with highest precedence. |
| `CLAUDE_OPENCODE_STATE_DIR` | Where sessions and logs are stored. |
| `CLAUDE_OPENCODE_LOG` | `debug`, `info`, `warn`, `error` or `silent`. |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code; used as the default workspace. |
