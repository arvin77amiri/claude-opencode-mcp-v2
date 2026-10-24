import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError } from "../../errors.js";
import { latestActivity } from "../../opencode/activity.js";
import { OpenCodeApiError } from "../../opencode/client.js";
import { requestId } from "../../util/text.js";
import { type AppContext, assertSession, loadWorkspaceConfig } from "../execute.js";
import { pickSessionId, type SessionArgs, sessionInputFor } from "../session-arg.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerGetSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_session",
    {
      title: "Get delegated session state",
      description:
        "Return the stored state of a delegated session plus its live OpenCode status when a server is running, including the time of the last agent activity (opencode.last_activity_at, idle_ms) so a long-running session can be told apart from a stuck one, and the cost and tokens of all its runs (usage). Use get_diff to inspect file changes.",
      inputSchema: {
        ...sessionInputFor(
          "The session_id returned by delegate_task/create_session (session_id is accepted as an alias).",
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: SessionArgs) => {
      const rid = requestId();
      try {
        const sid = pickSessionId(args, { source: "delegate_task", requirePrefix: false });
        const session = assertSession(ctx.registry.get(sid), sid);
        const config = await loadWorkspaceConfig(ctx, session.cwd);
        const maxChars = config.limits.sessionChars;
        const client = ctx.manager.existingClient();

        let liveStatus: string | null = null;
        let serverVersion: string | null = null;
        let live = false;
        let lastActivityAt: number | null = null;
        let lastActivity: string | null = null;

        if (client) {
          live = true;
          serverVersion = ctx.manager.getExistingServerVersion();
          try {
            await client.getSession(session.id);
            const active = await client.activeSessions();
            liveStatus = active[session.id]?.type ?? "idle";
            try {
              const page = await client.messages(session.id, { limit: 10, order: "desc" });
              const activity = latestActivity(page.data);
              if (activity) {
                lastActivityAt = activity.at;
                lastActivity = activity.summary;
              }
            } catch (error) {
              ctx.logger.debug("could not fetch session activity", {
                session_id: session.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } catch (error) {
            if (error instanceof OpenCodeApiError && error.status === 404) {
              throw new BridgeError(
                "OPENCODE_SESSION_NOT_FOUND",
                `OpenCode no longer knows session ${session.id}.`,
              );
            }
            if (error instanceof BridgeError) throw error;
            ctx.logger.debug("could not fetch live session status", {
              session_id: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
            liveStatus = null;
          }
        }

        const summary = session.lastSummary ?? "";
        const clipped = summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary;

        return jsonResult({
          session_id: session.id,
          cwd: session.cwd,
          agent: session.agent,
          provider: session.provider,
          model: session.model,
          title: session.title,
          status: session.status,
          ...(session.canEdit !== undefined ? { can_edit: session.canEdit } : {}),
          ...(session.canRunBash !== undefined ? { can_run_bash: session.canRunBash } : {}),
          created_at: session.createdAt,
          updated_at: session.updatedAt,
          ...(session.lastError ? { last_error: session.lastError } : {}),
          ...(session.lastSummary ? { last_summary: clipped } : {}),
          ...(session.durationMs !== undefined ? { duration_ms: session.durationMs } : {}),
          ...(session.usage ? { usage: session.usage } : {}),
          ...(session.lastMessageID ? { last_message_id: session.lastMessageID } : {}),
          ...backgroundInfo(ctx, session.id),
          opencode: live
            ? {
                live: true,
                status: liveStatus,
                server_version: serverVersion,
                ...(lastActivityAt !== null
                  ? {
                      last_activity_at: new Date(lastActivityAt).toISOString(),
                      idle_ms: Math.max(0, Date.now() - lastActivityAt),
                      last_activity: lastActivity,
                    }
                  : {}),
              }
            : { live: false, status: null, server_version: null },
        });
      } catch (error) {
        ctx.logger.error("get_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}

/** Background run state for get_session (the full result is returned by wait_session). */
function backgroundInfo(ctx: AppContext, sessionId: string): Record<string, unknown> {
  const snapshot = ctx.background.snapshot(sessionId);
  if (!snapshot) return {};
  const position = ctx.runSlots.position(sessionId);
  return {
    background: {
      state: snapshot.state,
      ...(position ? { queue_position: position } : {}),
      started_at: snapshot.started_at,
      finished_at: snapshot.finished_at,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    },
  };
}
