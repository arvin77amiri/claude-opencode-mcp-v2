import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import type { Logger } from "../util/logger.js";
import { BackgroundRuns } from "./background.js";
import { EditorLocks } from "./editor-locks.js";
import type { AppContext } from "./execute.js";
import { RunSlots } from "./run-slots.js";
import { registerAbortSession } from "./tools/abort-session.js";
import { registerCreateSession } from "./tools/create-session.js";
import { registerDelegateTask } from "./tools/delegate-task.js";
import { registerGetDiff } from "./tools/get-diff.js";
import { registerGetSession } from "./tools/get-session.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerWaitSession } from "./tools/wait-session.js";
import { registerDiscardTask, registerMergeTask } from "./tools/worktree-tasks.js";

export const SERVER_NAME = "claude-opencode-mcp";

/** Read the version from the packaged package.json so it never drifts. */
function resolveServerVersion(): string {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = resolveServerVersion();

export const SERVER_INSTRUCTIONS = [
  "Claude Code is the orchestrator; this server delegates focused tasks to OpenCode agents that run in the same workspace.",
  "Use delegate_task for one-shot work, or create_session + send_message for multi-step work that must keep context.",
  "Read-only agents: researcher, reviewer. Editing agent: coder. Test-running agent: tester.",
  "Agents do not see this conversation, so every task must be a self-contained brief. Always pass cwd (the absolute project root).",
  "Editing runs are isolated: each coder works in its own git worktree on branch oc/<agent>/<id> outside the repository (the result's worktree block names it), so coders can run in parallel and the user's checkout is untouched. Editing needs a clean git repository with at least one commit.",
  "After a coder session, call get_diff to inspect exactly what changed, and have reviewer and/or tester check it (pass the worktree's path as their cwd) before deciding; do not rely on the coder's own summary.",
  "Then call merge_task to squash the work onto the base branch as one commit, or discard_task to drop it. Never leave worktrees unresolved without telling the user.",
  "Paths supplied to delegate_task are exploration hints, not boundaries.",
  "To run agents in parallel, call delegate_task with background: true for each (it returns a session_id at once), then wait_session on each id. At most limits.maxConcurrentRuns (default 3) runs execute at once; the rest queue.",
].join(" ");

export interface CreateMcpServerOptions {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
  /** Background run tracker; pass one to stop its runs on shutdown. */
  background?: BackgroundRuns;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const ctx: AppContext = {
    logger: options.logger,
    manager: options.manager,
    registry: options.registry,
    globalConfig: options.globalConfig,
    env: options.env ?? process.env,
    stateDir: options.stateDir,
    editorLocks: new EditorLocks(),
    runSlots: new RunSlots(options.globalConfig.limits.maxConcurrentRuns),
    background: options.background ?? new BackgroundRuns(options.logger),
    ...(options.loadProjectConfig ? { loadProjectConfig: options.loadProjectConfig } : {}),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerDelegateTask(server, ctx);
  registerCreateSession(server, ctx);
  registerSendMessage(server, ctx);
  registerGetSession(server, ctx);
  registerGetDiff(server, ctx);
  registerAbortSession(server, ctx);
  registerWaitSession(server, ctx);
  registerMergeTask(server, ctx);
  registerDiscardTask(server, ctx);
  registerListAgents(server, ctx);

  return server;
}
