import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { BridgeError, isBridgeError } from "../errors.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import { runPrompt } from "../opencode/run.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import type { AgentSession, DelegateResult } from "../types/index.js";
import { diffSinceBaseline, lateGitBaseline } from "../util/git.js";
import type { Logger } from "../util/logger.js";
import { truncate } from "../util/text.js";
import { createProgressReporter, type ToolExtra } from "./tool-utils.js";

export interface AppContext {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
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
    const filesChanged = await countChangedFiles(prepared.client, session);

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
      ...(result.messageID ? { lastMessageID: result.messageID } : {}),
    });

    runLogger.info("delegated run finished", {
      status: result.status,
      duration_ms: result.durationMs,
      files_changed: filesChanged,
      findings: result.findings.length,
    });

    return {
      status: result.status,
      session_id: session.id,
      agent: session.agent,
      cwd: session.cwd,
      model: prepared.modelString,
      summary: truncatedSummary.text,
      findings: result.findings,
      files_changed: filesChanged,
      duration_ms: result.durationMs,
      truncated: truncatedSummary.truncated,
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
  }
}

export async function countChangedFiles(
  client: OpenCodeClient,
  session: AgentSession,
): Promise<number> {
  try {
    const entries = await client.diff(session.id);
    if (entries.length > 0) return entries.length;
  } catch {
    // fall through to the git baseline
  }
  try {
    const baseline = session.gitBaseline ?? (await lateGitBaseline(session.cwd));
    if (!baseline) return 0;
    return (await diffSinceBaseline(session.cwd, baseline)).files.length;
  } catch {
    return 0;
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
