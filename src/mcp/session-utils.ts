import { BridgeError } from "../errors.js";
import { createSessionRecord } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import { assertSessionLocation, type PrepareRunInput, prepareRun } from "../opencode/setup.js";
import type { AgentSession, SessionWorktree } from "../types/index.js";
import { captureGitBaseline } from "../util/git.js";
import { createTaskWorktree, removeTaskWorktree } from "../workspace/worktree.js";
import type { AppContext } from "./execute.js";

export function defaultSessionTitle(agent: string, task: string): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  const short = cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
  return `${agent}: ${short || "delegated task"}`;
}

/** Whether a run with these capabilities must be isolated in a worktree. */
export function needsWorktree(prepared: PreparedRun): boolean {
  return prepared.config.worktrees.enabled && prepared.capabilities.canEdit;
}

function worktreeKey(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Create the OpenCode session for a delegated task. An editing run (with
 * worktrees enabled) first gets its own worktree + branch, and the session,
 * the prompt context and the run all use the worktree: `prepared.workspace`
 * is switched to it in place.
 */
export async function createDelegatedSession(
  ctx: AppContext,
  prepared: PreparedRun,
  title?: string | null,
): Promise<AgentSession> {
  const originCwd = prepared.workspace.cwd;
  let worktree: SessionWorktree | undefined;
  if (needsWorktree(prepared)) {
    const created = await createTaskWorktree({
      cwd: originCwd,
      key: worktreeKey(),
      agent: prepared.baseAgentName,
    });
    worktree = { ...created, state: "active" };
    prepared.workspace = { ...prepared.workspace, cwd: created.cwd, gitRoot: created.path };
    ctx.logger.info("created task worktree", {
      repo: created.repoRoot,
      path: created.path,
      branch: created.branch,
    });
  }

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
    if (worktree) await removeTaskWorktree(worktree);
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
    ...(worktree ? { worktree, originCwd } : {}),
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

/**
 * Prepare a follow-up run on an existing session. A worktree session is
 * prepared against the workspace the orchestrator originally asked for
 * (config, allowed roots and project agents come from there) and then pointed
 * back at its worktree.
 */
export async function prepareSessionRun(
  ctx: AppContext,
  session: AgentSession,
  input: Omit<PrepareRunInput, "cwd" | "agent">,
): Promise<PreparedRun> {
  const wt = session.worktree;
  if (wt && wt.state !== "active") {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Session ${session.id} was ${wt.state}${wt.mergedCommit ? ` (commit ${wt.mergedCommit.slice(0, 12)})` : ""}; its worktree is gone. Start a new delegate_task.`,
      { details: { session_id: session.id, worktree_state: wt.state } },
    );
  }
  const prepared = await prepareRun(ctx, {
    ...input,
    cwd: session.originCwd ?? session.cwd,
    agent: session.agent,
  });
  if (wt) {
    prepared.workspace = { ...prepared.workspace, cwd: session.cwd, gitRoot: wt.path };
  } else if (needsWorktree(prepared)) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Session ${session.id} was created without edits, so it runs in ${session.cwd} directly and cannot be given edits now (editing runs are isolated in a worktree). Start a new delegate_task with an editing agent or allow_edits: true.`,
      { details: { session_id: session.id } },
    );
  }
  return prepared;
}

/** The `worktree` block added to tool results of a worktree session. */
export function worktreeSummary(session: AgentSession): Record<string, unknown> {
  const wt = session.worktree;
  if (!wt) return {};
  return {
    worktree: {
      state: wt.state,
      branch: wt.branch,
      base_branch: wt.baseBranch,
      repo: wt.repoRoot,
      path: wt.path,
      ...(wt.mergedCommit ? { merged_commit: wt.mergedCommit } : {}),
      ...(wt.cleanupPending ? { cleanup_pending: true } : {}),
      ...(wt.leftoverDir ? { leftover_dir: wt.leftoverDir } : {}),
      ...(wt.state === "active"
        ? {
            next: "Review with get_diff (and reviewer/tester agents), then merge_task to squash it onto the base branch or discard_task to drop it.",
          }
        : {}),
    },
  };
}
