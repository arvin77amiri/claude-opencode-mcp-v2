import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { READ_MAX_CHARS, READ_MAX_IDS, readMessages } from "../../opencode/message-reader.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { asSessionError, readOnlyClient } from "../read-client.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export const READ_MESSAGES_DESCRIPTION =
  "Read a few messages of one earlier OpenCode session, in a compact form. " +
  "Either message_ids (up to 20: e.g. the message_ids of a find_sessions content match or the " +
  "msg_id of a session_digest error) or around (one message id) with `before` readable messages " +
  "ahead of it (default 1) and `after` readable messages behind it (default 2). " +
  "Returns {session_id, messages: [{id, type: user|assistant|compaction|shell|idle, time, text, " +
  "tools: [{name, status, input_summary, error?}], error?, finish?, truncated}], more?, " +
  "remaining_ids?, missing_ids?}. max_chars (default 4000) is the budget for the WHOLE answer: " +
  "when it is exceeded the rest is left out and more: true is set (remaining_ids can be asked " +
  "for in a second call). Never includes reasoning, base64 attachments, raw tool output or the " +
  "content of write/edit calls (tools show their path or command only). " +
  "Read-only (GET only); never starts OpenCode. " +
  "Workflow: list_projects -> find_sessions -> session_digest -> read_messages " +
  "(only the ids you need).";

export function registerReadMessages(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "read_messages",
    {
      title: "Read messages of an earlier OpenCode session",
      description: READ_MESSAGES_DESCRIPTION,
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("A session_id from find_sessions (starts with ses)."),
        message_ids: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(READ_MAX_IDS)
          .optional()
          .describe("Exact message ids to read, in the order to show them."),
        around: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("One message id; its neighbours are read too (use instead of message_ids)."),
        before: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(1)
          .describe("With around: how many readable messages to show before it."),
        after: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(2)
          .describe("With around: how many readable messages to show after it."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(12_000)
          .default(READ_MAX_CHARS)
          .describe("Total size budget of the answer in characters."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: {
      session_id: string;
      message_ids?: string[];
      around?: string;
      before?: number;
      after?: number;
      max_chars?: number;
    }) => {
      const rid = requestId();
      try {
        const sessionId = args.session_id.trim();
        if (!sessionId.startsWith("ses")) {
          throw new BridgeError(
            "INVALID_ARGUMENT",
            `"${args.session_id}" is not a session id (they start with "ses"). Use a session_id from find_sessions.`,
          );
        }
        const hasIds = (args.message_ids?.length ?? 0) > 0;
        if (hasIds === Boolean(args.around)) {
          throw new BridgeError(
            "INVALID_ARGUMENT",
            "Pass either message_ids or around (exactly one of them).",
          );
        }
        const client = await readOnlyClient(ctx);
        const answer = await readMessages(client, {
          sessionId,
          ...(hasIds ? { messageIds: args.message_ids as string[] } : {}),
          ...(args.around ? { around: args.around } : {}),
          before: args.before ?? 1,
          after: args.after ?? 2,
          maxChars: args.max_chars ?? READ_MAX_CHARS,
        });
        return jsonResult(answer, { compact: true, structured: false });
      } catch (error) {
        ctx.logger.error("read_messages failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(asSessionError(error, args.session_id), rid);
      }
    },
  );
}
