import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import type { AgentSession, SessionWorktree } from "../../types/index.js";
import { requestId } from "../../util/text.js";
import {
  type CleanupResult,
  mergeTaskWorktree,
  removeTaskWorktree,
} from "../../workspace/worktree.js";
import { type AppContext, assertSession } from "../execute.js";
import { worktreeSummary } from "../session-utils.js";
import { errorResult, jsonResult } from "../tool-utils.js";

/** Serialises merges/discards per repository inside this bridge process. */
const repoQueues = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  repoQueues.set(repo, next);
  // Both branches handled: a rejected `next` must not become an unhandled rejection
  // (that crashes the bridge process); the caller gets the rejection from `next` itself.
  const release = () => {
    if (repoQueues.get(repo) === next) repoQueues.delete(repo);
  };
  next.then(release, release);
  return next;
}

/**
 * Retry the cleanups that failed earlier (worktree directory still locked).
 * Best effort and quiet: one attempt per worktree, errors only logged.
 */
export async function sweepPendingCleanups(ctx: AppContext): Promise<number> {
  let cleaned = 0;
  for (const session of ctx.registry.list()) {
    const wt = session.worktree;
    if (!wt?.cleanupPending) continue;
    try {
      const result = await withRepoLock(wt.repoRoot, () => removeTaskWorktree(wt, [0]));
      if (result.removed) {
        const { cleanupPending: _done, ...rest } = wt;
        ctx.registry.upsert({ ...session, worktree: rest });
        ctx.logger.info("cleaned up pending task worktree", {
          session_id: session.id,
          path: wt.path,
        });
        cleaned += 1;
      }
    } catch (error) {
      ctx.logger.debug("pending worktree cleanup failed", {
        session_id: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return cleaned;
}

/** Start a background sweep of pending cleanups (never awaited, never throws). */
export function kickSweep(ctx: AppContext): void {
  sweepPendingCleanups(ctx).catch(() => undefined);
}

function cleanupFields(cleanup: CleanupResult): { cleanupPending?: string } {
  return cleanup.removed ? {} : { cleanupPending: cleanup.error ?? "worktree still present" };
}

function cleanupNote(cleanup: CleanupResult): Record<string, unknown> {
  if (cleanup.removed) return {};
  return {
    cleanup_pending: true,
    cleanup_note: `The worktree directory or branch could not be deleted yet (${cleanup.error ?? "locked"}); the bridge retries on later calls and at startup. Your project is not affected.`,
  };
}

function activeWorktree(
  ctx: AppContext,
  sessionId: string,
): {
  session: AgentSession;
  wt: SessionWorktree;
} {
  const session = assertSession(ctx.registry.get(sessionId), sessionId);
  const wt = session.worktree;
  if (!wt) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Session ${session.id} has no worktree (it did not edit, or ran with worktrees disabled). There is nothing to merge or discard.`,
      { details: { session_id: session.id } },
    );
  }
  if (wt.state !== "active") {
    throw new BridgeError("INVALID_ARGUMENT", `Session ${session.id} was already ${wt.state}.`, {
      details: { session_id: session.id, worktree_state: wt.state },
    });
  }
  const busy =
    ctx.background.isActive(session.id) ||
    ctx.runSlots.position(session.id) !== null ||
    session.status === "running" ||
    session.status === "queued";
  if (busy) {
    throw new BridgeError(
      "WORKSPACE_BUSY",
      `Session ${session.id} is still ${session.status}. Wait for it (wait_session) or abort it (abort_session) first.`,
      { details: { session_id: session.id, status: session.status }, retryable: true },
    );
  }
  return { session, wt };
}

function setWorktree(ctx: AppContext, session: AgentSession, wt: SessionWorktree): AgentSession {
  const updated = { ...session, worktree: wt };
  ctx.registry.upsert(updated);
  return updated;
}

export function registerMergeTask(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "merge_task",
    {
      title: "Merge a task's worktree into its base branch",
      description:
        "Accept the work of an editing session: everything on its worktree branch (committed or not) is squashed into ONE commit on the branch the task started from, then the worktree and branch are deleted. The bridge makes the commit, never the agent. Requires the user's checkout to still be on that branch with no uncommitted changes to tracked files (else WORKSPACE_DIRTY / INVALID_ARGUMENT; nothing is changed). On conflict (MERGE_CONFLICT) the checkout is restored exactly and the worktree is kept: send the session a follow-up to rebase its work, or discard_task. Review with get_diff first.",
      inputSchema: {
        session_id: z.string().min(1).max(200).describe("Session id of the editing task."),
        message: z
          .string()
          .min(1)
          .max(5_000)
          .optional()
          .describe("Commit message (default: the session title)."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (args: { session_id: string; message?: string }) => {
      const rid = requestId();
      try {
        const { session, wt } = activeWorktree(ctx, args.session_id);
        const message =
          args.message?.trim() || session.title || `${session.agent}: delegated task ${session.id}`;
        const outcome = await withRepoLock(wt.repoRoot, () => mergeTaskWorktree(wt, message));

        if (outcome.status === "conflict") {
          throw new BridgeError(
            "MERGE_CONFLICT",
            `Merging ${wt.branch} into ${wt.baseBranch} conflicts in ${outcome.files.length} file(s). Your checkout was left unchanged and the worktree is kept. Ask the agent (send_message) to integrate the latest ${wt.baseBranch} into its work, or discard_task.`,
            {
              details: {
                session_id: session.id,
                branch: wt.branch,
                base_branch: wt.baseBranch,
                files: outcome.files,
              },
            },
          );
        }
        const updated = setWorktree(ctx, session, {
          ...wt,
          state: "merged",
          ...(outcome.status === "merged" ? { mergedCommit: outcome.commit } : {}),
          ...cleanupFields(outcome.cleanup),
        });
        kickSweep(ctx);
        ctx.logger.info("merged task worktree", {
          session_id: session.id,
          branch: wt.branch,
          outcome: outcome.status,
        });
        return jsonResult({
          session_id: session.id,
          merged: outcome.status === "merged",
          ...(outcome.status === "merged"
            ? { commit: outcome.commit, base_branch: wt.baseBranch, files: outcome.files }
            : {
                note: "The task made no changes (or its changes are already on the base branch); nothing was committed.",
              }),
          ...cleanupNote(outcome.cleanup),
          ...worktreeSummary(updated),
        });
      } catch (error) {
        ctx.logger.error("merge_task failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}

export function registerDiscardTask(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "discard_task",
    {
      title: "Discard a task's worktree",
      description:
        "Reject the work of an editing session: delete its worktree and branch. The user's checkout is not touched. Cannot be undone.",
      inputSchema: {
        session_id: z.string().min(1).max(200).describe("Session id of the editing task."),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (args: { session_id: string }) => {
      const rid = requestId();
      try {
        const { session, wt } = activeWorktree(ctx, args.session_id);
        const cleanup = await withRepoLock(wt.repoRoot, () => removeTaskWorktree(wt));
        const updated = setWorktree(ctx, session, {
          ...wt,
          state: "discarded",
          ...cleanupFields(cleanup),
        });
        ctx.logger.info("discarded task worktree", {
          session_id: session.id,
          branch: wt.branch,
          removed: cleanup.removed,
        });
        kickSweep(ctx);
        return jsonResult({
          session_id: session.id,
          discarded: true,
          ...cleanupNote(cleanup),
          ...worktreeSummary(updated),
        });
      } catch (error) {
        ctx.logger.error("discard_task failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
