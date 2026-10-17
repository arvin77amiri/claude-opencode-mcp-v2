import { BridgeError } from "../errors.js";
import { createSessionRecord } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import { assertSessionLocation } from "../opencode/setup.js";
import type { AgentSession } from "../types/index.js";
import { captureGitBaseline } from "../util/git.js";
import type { AppContext } from "./execute.js";

export function defaultSessionTitle(agent: string, task: string): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  const short = cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
  return `${agent}: ${short || "delegated task"}`;
}

export async function createDelegatedSession(
  ctx: AppContext,
  prepared: PreparedRun,
  title?: string | null,
): Promise<AgentSession> {
  let opencodeId: string;
  try {
    const info = await prepared.client.createSession({
      ...(title?.trim() ? { title: title.trim() } : {}),
      ...(prepared.agentBinding.agent ? { agent: prepared.agentBinding.agent } : {}),
      ...(prepared.model ? { model: prepared.model } : {}),
      location: { directory: prepared.workspace.cwd },
      permissions: prepared.permissions,
    });
    assertSessionLocation(info.location?.directory, prepared.workspace);
    opencodeId = info.id;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `Could not create an OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, retryable: true },
    );
  }

  const gitBaseline = await captureGitBaseline(prepared.workspace.cwd);
  const session = createSessionRecord({
    id: opencodeId,
    cwd: prepared.workspace.cwd,
    agent: prepared.baseAgentName,
    ...(prepared.definition.name !== prepared.baseAgentName
      ? { promptAgent: prepared.definition.name }
      : {}),
    canEdit: prepared.capabilities.canEdit,
    canRunBash: prepared.capabilities.canRunBash,
    provider: prepared.model?.providerID ?? null,
    model: prepared.modelString,
    title: title?.trim() ? title.trim() : null,
    ...(gitBaseline ? { gitBaseline } : {}),
  });
  ctx.registry.upsert(session);
  ctx.logger.info("created delegated session", {
    session_id: session.id,
    cwd: session.cwd,
    agent: session.agent,
    model: session.model,
  });
  return session;
}
