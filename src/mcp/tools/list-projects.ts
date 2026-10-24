import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjectRows } from "../../opencode/project-catalog.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { asBridgeError, readOnlyClient } from "../read-client.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export const LIST_PROJECTS_DESCRIPTION =
  "List the OpenCode projects (folders) whose past sessions can be browsed: " +
  "[{id, name, path, session_count, last_activity}], newest activity first. " +
  "session_count counts root sessions (sub-agent runs excluded); projects without sessions are " +
  "left out (hidden_empty). Read-only (GET only); never starts OpenCode. " +
  "Workflow to find earlier work: list_projects -> find_sessions (project = id, path or name) -> " +
  "session_digest -> read_messages (the last two arrive in later versions).";

export function registerListProjects(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List OpenCode projects",
      description: LIST_PROJECTS_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rid = requestId();
      try {
        const client = await readOnlyClient(ctx);
        const listing = await listProjectRows(client);
        return jsonResult(
          {
            projects: listing.projects,
            ...(listing.hidden_empty > 0 ? { hidden_empty: listing.hidden_empty } : {}),
            ...(listing.omitted > 0 ? { omitted: listing.omitted } : {}),
            ...(listing.partial ? { partial: true } : {}),
          },
          { compact: true, structured: false },
        );
      } catch (error) {
        ctx.logger.error("list_projects failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(asBridgeError(error), rid);
      }
    },
  );
}
