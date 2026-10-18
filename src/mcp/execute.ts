import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { BridgeError, isBridgeError } from "../errors.js";
import type { FileDiff } from "../opencode/api-types.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import { addUsage, runPrompt } from "../opencode/run.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import type { AgentSession, DelegateResult, DiffFileSummary } from "../types/index.js";
import { diffSinceBaseline, lateGitBaseline } from "../util/git.js";
import type { Logger } from "../util/logger.js";
import { truncate } from "../util/text.js";
import type { EditorLocks } from "./editor-locks.js";
import { createProgressReporter, type ToolExtra } from "./tool-utils.js";

export interface AppContext {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  editorLocks: EditorLocks;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

export async function loadWorkspaceConfig(ctx: AppContext, cwd: string): Promise<ResolvedConfig> {
  if (ctx.loadProjectConfig) {
    return (await ctx.loadProjectConfig(cwd)).config;
  }
  return (await loadConfig({ cwd, env: ctx.env })).config;
}

export interface ExecuteRunInput {
  prepared: PreparedRun;
  session: AgentSession;
  text: string;
  timeoutMs: number;
  extra: ToolExtra;
  requestId: string;
}

export async function executeRun(ctx: AppContext, input: ExecuteRunInput): Promise<DelegateResult> {
  const { prepared, session } = input;
  const progress = createProgressReporter(input.extra, ctx.logger, input.requestId);
  const runLogger = ctx.logger.child({
    request_id: input.requestId,
    session_id: session.id,
    agent: session.agent,
    cwd: session.cwd,
  });

  const releaseEditor = prepared.capabilities.canEdit
    ? ctx.editorLocks.acquire(session.cwd, session.id)
    : null;
  ctx.registry.update(session.id, { status: "running", lastError: undefined });
  ctx.manager.beginRun(prepared.serverKey, session.id);

  try {
    // Permissions and agent are per session in OpenCode 2.x; re-sync them so
    // send_message overrides (allow_edits / allow_bash) take effect.
    await prepared.client.patchSession(session.id, { permissions: prepared.permissions });
    if (prepared.agentBinding.agent) {
      await prepared.client.setSessionAgent(session.id, prepared.agentBinding.agent);
    }

    const result = await runPrompt({
      client: prepared.client,
      sessionId: session.id,
      text: `${prepared.agentBinding.promptPreamble ?? ""}${input.text}`,
      timeoutMs: input.timeoutMs,
      ...(progress ? { onProgress: progress } : {}),
      ...(input.extra.signal ? { signal: input.extra.signal } : {}),
      logger: runLogger,
    });

    const truncatedSummary = truncate(result.summary, prepared.config.limits.summaryChars);
    const changed = await changedFiles(prepared.client, session);

    const status: AgentSession["status"] =
      result.status === "completed"
        ? "completed"
        : result.status === "timeout"
          ? "timeout"
          : "failed";

    ctx.registry.update(session.id, {
      status,
      ...(truncatedSummary.text ? { lastSummary: truncatedSummary.text } : {}),
      ...(result.error
        ? { lastError: { code: result.error.code, message: result.error.message } }
        : { lastError: undefined }),
      durationMs: result.durationMs,
      ...(result.usage
        ? { usage: addUsage(ctx.registry.get(session.id)?.usage, result.usage) }
        : {}),
      ...(result.messageID ? { lastMessageID: result.messageID } : {}),
    });

    runLogger.info("delegated run finished", {
      status: result.status,
      duration_ms: result.durationMs,
      files_changed: changed.length,
      findings: result.findings.length,
      ...(result.usage ? { cost: result.usage.cost } : {}),
    });

    return {
      status: result.status,
      session_id: session.id,
      agent: session.agent,
      cwd: session.cwd,
      model: prepared.modelString,
      summary: truncatedSummary.text,
      findings: result.findings,
      files_changed: changed.length,
      changed_files: changed.slice(0, MAX_CHANGED_FILES),
      duration_ms: result.durationMs,
      truncated: truncatedSummary.truncated,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              ...(result.error.details ? { details: result.error.details } : {}),
            },
          }
        : {}),
    };
  } catch (error) {
    const code = isBridgeError(error) ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    ctx.registry.update(session.id, {
      status: code === "AGENT_ABORTED" ? "aborted" : "failed",
      lastError: { code, message },
    });
    throw error;
  } finally {
    ctx.manager.endRun(prepared.serverKey, session.id);
    releaseEditor?.();
  }
}

/** Cap on `changed_files` in a run result; `files_changed` stays the full count. */
export const MAX_CHANGED_FILES = 100;

export function normalizeDiffStatus(status: string | undefined): DiffFileSummary["status"] {
  switch (status) {
    case "added":
    case "deleted":
    case "renamed":
    case "modified":
      return status;
    default:
      return status ? "unknown" : "modified";
  }
}

export function summarizeDiffEntry(entry: FileDiff): DiffFileSummary {
  return {
    file: entry.file,
    additions: entry.additions,
    deletions: entry.deletions,
    status: normalizeDiffStatus(entry.status),
  };
}

/** Files changed by a session: OpenCode's diff, or the git diff against its baseline. */
export async function changedFiles(
  client: OpenCodeClient,
  session: AgentSession,
): Promise<DiffFileSummary[]> {
  try {
    const entries = await client.diff(session.id);
    if (entries.length > 0) return entries.map(summarizeDiffEntry);
  } catch {
    // fall through to the git baseline
  }
  try {
    const baseline = session.gitBaseline ?? (await lateGitBaseline(session.cwd));
    if (!baseline) return [];
    return (await diffSinceBaseline(session.cwd, baseline)).files;
  } catch {
    return [];
  }
}

export function assertSession(session: AgentSession | null, sessionId: string): AgentSession {
  if (!session) {
    throw new BridgeError("OPENCODE_SESSION_NOT_FOUND", `Unknown session: ${sessionId}`, {
      details: {
        session_id: sessionId,
        hint: "Create a session with create_session or delegate_task first.",
      },
    });
  }
  return session;
}
