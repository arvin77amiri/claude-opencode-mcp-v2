import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveExecutionTimeout } from "../../config/config.js";
import { effectivePermissionOverride } from "../../opencode/setup.js";
import { requestId } from "../../util/text.js";
import { buildTaskPrompt } from "../../workspace/context.js";
import type { AppContext } from "../execute.js";
import {
  assertNoActiveBackgroundRun,
  assertSession,
  executeRun,
  startBackgroundRun,
} from "../execute.js";
import { prepareSessionRun, worktreeSummary } from "../session-utils.js";
import { errorResult, jsonResult, type ToolExtra } from "../tool-utils.js";

export function registerSendMessage(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a follow-up message to a session",
      description:
        "Continue an existing delegated session with another message. The agent keeps its previous context and its permission level; allow_edits / allow_bash can change that level for this and later messages. Returns the same result as delegate_task; an editing run fails with WORKSPACE_BUSY while another one is in progress on an overlapping cwd. With background: true it returns at once; collect the result with wait_session.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
        message: z.string().min(1).max(50_000).describe("Follow-up instruction or question."),
        timeout: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe("Execution timeout in milliseconds (default from bridge config)."),
        allow_edits: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) file edits from this message onward. Omit to keep the session's current level.",
          ),
        allow_bash: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) shell commands from this message onward. Omit to keep the session's current level.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Return immediately with { session_id, status: running|queued } and keep the run going in the bridge; collect the result with wait_session. Use it to run several agents in parallel.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async (
      args: {
        session_id: string;
        message: string;
        timeout?: number;
        allow_edits?: boolean;
        allow_bash?: boolean;
        background?: boolean;
      },
      extra: ToolExtra,
    ) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        assertNoActiveBackgroundRun(ctx, session.id);
        const prepared = await prepareSessionRun(ctx, session, {
          model: session.model ?? undefined,
          allowEdits: args.allow_edits ?? session.canEdit,
          allowBash: args.allow_bash ?? session.canRunBash,
        });
        const override = effectivePermissionOverride(prepared);
        const text = buildTaskPrompt({
          workspace: prepared.workspace,
          task: args.message,
          hints: [],
          capabilities: prepared.capabilities,
          agentName: prepared.baseAgentName,
          compact: true,
          ...(override ? { override } : {}),
        });
        const timeoutMs = resolveExecutionTimeout(prepared.config, args.timeout);

        // Keep the session's permission level in sync with what was used.
        const promptAgent =
          prepared.definition.name !== prepared.baseAgentName
            ? prepared.definition.name
            : undefined;
        const updated: typeof session = {
          ...session,
          ...(promptAgent ? { promptAgent } : { promptAgent: undefined }),
          canEdit: prepared.capabilities.canEdit,
          canRunBash: prepared.capabilities.canRunBash,
        };
        if (args.background && prepared.capabilities.canEdit) {
          ctx.editorLocks.assertFree(prepared.workspace.cwd);
        }
        ctx.registry.upsert(updated);

        if (args.background) {
          return jsonResult({
            ...startBackgroundRun(ctx, {
              prepared,
              session: updated,
              text,
              timeoutMs,
              requestId: rid,
            }),
            ...worktreeSummary(updated),
          });
        }

        const result = await executeRun(ctx, {
          prepared,
          session: updated,
          text,
          timeoutMs,
          extra,
          requestId: rid,
        });
        return jsonResult(
          { ...result, ...worktreeSummary(updated) },
          { isError: result.status !== "completed" },
        );
      } catch (error) {
        ctx.logger.error("send_message failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
