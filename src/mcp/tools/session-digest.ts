import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DIGEST_MAX_CHARS, digestSession } from "../../opencode/session-digest.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { asSessionError, readOnlyClient } from "../read-client.js";
import { pickSessionId, type SessionArgs, sessionInput } from "../session-arg.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export const SESSION_DIGEST_DESCRIPTION =
  "A short summary (about 1500 characters at most) of one earlier OpenCode session: " +
  "{title, goal (first user message), last_request (last user message), compaction_summary " +
  "(latest, if any), files_changed (paths from write/edit calls), errors [{msg_id, idle_msg_id?, type, " +
  "message}] (latest first), final_state {outcome, finish, idle_error}, tools_used {name: count}, " +
  "counts {messages, user, assistant}, fingerprint}. " +
  "errors carry the real failure (provider errors, failed tools, failed runs); their msg_id " +
  "goes straight into read_messages (it points to the assistant message, where the context is; " +
  "idle_msg_id is the idle message that reported the same error, rarely worth reading). fingerprint changes whenever the session does. " +
  "partial: true means some data is missing (time budget or a failed read); truncated: true " +
  "means fields were shortened to fit the cap. Never includes reasoning, tool output or file " +
  "contents. Read-only (GET only); never starts OpenCode. " +
  "Workflow: list_projects -> find_sessions -> session_digest -> read_messages " +
  "(only the messages you need).";

export function registerSessionDigest(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "session_digest",
    {
      title: "Summarize an earlier OpenCode session",
      description: SESSION_DIGEST_DESCRIPTION,
      inputSchema: sessionInput,
      annotations: { readOnlyHint: true },
    },
    async (args: SessionArgs) => {
      const rid = requestId();
      let sessionId = "";
      try {
        sessionId = pickSessionId(args);
        const client = await readOnlyClient(ctx);
        const digest = await digestSession(client, sessionId, { maxChars: DIGEST_MAX_CHARS });
        return jsonResult(digest, { compact: true, structured: false });
      } catch (error) {
        ctx.logger.error("session_digest failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(asSessionError(error, sessionId), rid);
      }
    },
  );
}
