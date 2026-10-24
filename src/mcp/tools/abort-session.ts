import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { assertSession } from "../execute.js";
import { pickSessionId, type SessionArgs, sessionInputFor } from "../session-arg.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerAbortSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "abort_session",
    {
      title: "Abort a running delegated session",
      description:
        "Stop a long-running or unwanted delegated task. Safe to call when the session is already idle.",
      inputSchema: {
        ...sessionInputFor(
          "The session_id returned by delegate_task/create_session (session_id is accepted as an alias).",
        ),
      },
      annotations: { destructiveHint: true },
    },
    async (args: SessionArgs) => {
      const rid = requestId();
      try {
        const sid = pickSessionId(args, { source: "delegate_task", requirePrefix: false });
        const session = assertSession(ctx.registry.get(sid), sid);
        // A queued background run never reached OpenCode: cancelling it is enough.
        const queued = ctx.runSlots.position(session.id) !== null;
        const backgroundAborted = ctx.background.abort(session.id);
        if (queued && backgroundAborted) {
          ctx.registry.setStatus(session.id, "aborted");
          ctx.logger.info("cancelled queued background run", { session_id: session.id });
          return jsonResult({ session_id: session.id, aborted: true, was: "queued" });
        }
        const client = ctx.manager.existingClient();
        if (!client) {
          ctx.registry.setStatus(session.id, "aborted");
          return jsonResult({
            session_id: session.id,
            aborted: true,
            note: "No OpenCode server is running for this workspace; session marked as aborted.",
          });
        }

        // Idempotent in OpenCode 2: `interrupted:false` when nothing was running.
        await client.interrupt(session.id);
        ctx.registry.setStatus(session.id, "aborted");
        ctx.logger.info("aborted delegated session", { session_id: session.id });
        return jsonResult({ session_id: session.id, aborted: true });
      } catch (error) {
        ctx.logger.error("abort_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
