import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { assertSession } from "../execute.js";
import { pickSessionId, type SessionArgs, sessionInputFor } from "../session-arg.js";
import { createProgressReporter, errorResult, jsonResult, type ToolExtra } from "../tool-utils.js";

/** Default wait: short enough to stay under MCP client request timeouts. */
export const DEFAULT_WAIT_MS = 120_000;

export function registerWaitSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "wait_session",
    {
      title: "Wait for a background run",
      description: [
        "Wait for a run started with background: true and return its result: the same object delegate_task returns",
        "(status, summary, findings, changed_files, usage, ...). If the run is still queued or running when",
        "timeout elapses, returns { session_id, status: queued|running, done: false } instead; call it again.",
        "To run agents in parallel: start each with background: true, then wait_session on each session_id.",
      ].join(" "),
      inputSchema: {
        ...sessionInputFor(
          "The session_id returned by delegate_task/send_message with background: true (session_id is accepted as an alias).",
        ),
        timeout: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe(
            `Maximum time to wait in milliseconds (default ${DEFAULT_WAIT_MS}; 0 only checks).`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: SessionArgs & { timeout?: number }, extra: ToolExtra) => {
      const rid = requestId();
      try {
        const sid = pickSessionId(args, { source: "delegate_task", requirePrefix: false });
        const session = assertSession(ctx.registry.get(sid), sid);
        const progress = createProgressReporter(extra, ctx.logger, rid);
        const startedWaiting = Date.now();
        const snapshot = await ctx.background.wait(
          session.id,
          args.timeout ?? DEFAULT_WAIT_MS,
          async (current) => {
            const position = ctx.runSlots.position(session.id);
            await progress?.({
              progress: 50,
              message: position ? `queued (position ${position})` : `${current.state}…`,
            });
          },
          extra.signal,
        );

        if (!snapshot) {
          // No background run in this bridge process (blocking run, or a bridge restart).
          const latest = ctx.registry.get(session.id) ?? session;
          return jsonResult({
            session_id: session.id,
            done: latest.status !== "running" && latest.status !== "queued",
            background: false,
            status: latest.status,
            ...(latest.lastSummary ? { summary: latest.lastSummary } : {}),
            ...(latest.lastError ? { last_error: latest.lastError } : {}),
            note: "No background run is tracked for this session in this bridge process; this is the stored session state.",
          });
        }

        if (snapshot.state !== "done") {
          const position = ctx.runSlots.position(session.id);
          return jsonResult({
            session_id: session.id,
            done: false,
            status: position ? "queued" : "running",
            ...(position ? { queue_position: position } : {}),
            waited_ms: Date.now() - startedWaiting,
            next: "Still in progress: call wait_session again, or abort_session to cancel.",
          });
        }

        if (snapshot.result) {
          return jsonResult(
            { ...snapshot.result, done: true },
            { isError: snapshot.result.status !== "completed" },
          );
        }
        return jsonResult(
          {
            session_id: session.id,
            done: true,
            status: ctx.registry.get(session.id)?.status ?? "failed",
            error: snapshot.error,
          },
          { isError: true },
        );
      } catch (error) {
        ctx.logger.error("wait_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
