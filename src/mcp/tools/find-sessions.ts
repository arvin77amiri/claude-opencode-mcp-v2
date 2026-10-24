import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { describeProjects, mergeTwinRows } from "../../opencode/project-catalog.js";
import { projectName, resolveProjectGroup } from "../../opencode/project-resolver.js";
import { fitToBudget, mergeSearchResults, searchSessions } from "../../opencode/session-search.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { asBridgeError, readOnlyClient } from "../read-client.js";
import { errorResult, jsonResult } from "../tool-utils.js";

/** Hard cap on the size of one answer. */
export const FIND_SESSIONS_MAX_CHARS = 4_000;
/** Per-call time budget; a slow scan returns what it has with partial: true. */
export const FIND_SESSIONS_BUDGET_MS = 15_000;

export const FIND_SESSIONS_DESCRIPTION =
  "Find earlier OpenCode sessions of one project. " +
  "project: an id, a folder path or a name from list_projects (case-insensitive); an ambiguous " +
  "name returns candidates instead of guessing. " +
  "Without query: the most recent root sessions. With query: sessions whose TITLE matches, plus " +
  "sessions whose conversation (user and assistant text, errors, tool paths/commands - never " +
  "tool output or reasoning) contains every word of the query, searched in the `scan` most " +
  "recent sessions. " +
  "Returns [{session_id, title, updated, outcome, match: title|content, snippet, message_ids}] " +
  "(message_ids point at the matching messages; content matches only). Answers stay under about " +
  "4000 characters; partial: true means the 15 s time budget ran out before every session was " +
  "searched (use a narrower query or a lower scan). A folder listed under several project ids " +
  "(twins) counts as ONE project: their sessions are merged and every id is reported in " +
  "project.ids. Read-only (GET only); never starts OpenCode. " +
  "Workflow: list_projects -> find_sessions -> session_digest (summary of one session) -> " +
  "read_messages (only the messages you need). Pass the session_id to session_digest, and the " +
  "session_id with the message_ids from a content match straight to read_messages.";

export function registerFindSessions(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "find_sessions",
    {
      title: "Find earlier OpenCode sessions",
      description: FIND_SESSIONS_DESCRIPTION,
      inputSchema: {
        project: z
          .string()
          .min(1)
          .max(4_096)
          .describe("Project id, folder path or name (see list_projects)."),
        query: z
          .string()
          .max(300)
          .optional()
          .describe("Words to look for in titles and conversation text (all words must match)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum number of sessions returned."),
        scan: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many of the most recent sessions to search by content when query is set."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { project: string; query?: string; limit?: number; scan?: number }) => {
      const rid = requestId();
      try {
        const client = await readOnlyClient(ctx);
        const resolution = resolveProjectGroup(await client.projects(), args.project);

        if (resolution.status === "not_found") {
          throw new BridgeError(
            "INVALID_ARGUMENT",
            `No OpenCode project matches "${args.project}". Call list_projects for the available ids, paths and names.`,
          );
        }
        if (resolution.status === "ambiguous") {
          // Counts and last activity let the caller tell look-alike projects apart.
          const { rows } = await describeProjects(client, resolution.candidates, {
            budgetMs: FIND_SESSIONS_BUDGET_MS,
          });
          return jsonResult(
            {
              status: "ambiguous",
              message: `"${args.project}" matches several projects; call find_sessions again with one id.`,
              candidates: mergeTwinRows(rows),
            },
            { compact: true, structured: false },
          );
        }

        // Twins (one folder, several project ids) are searched together and merged.
        const { projects: group } = resolution;
        const [project] = group;
        if (!project)
          throw new BridgeError("INTERNAL_ERROR", "Project resolution returned no project.");
        const limit = args.limit ?? 10;
        const results = await Promise.all(
          group.map((member) =>
            searchSessions(client, {
              project: member.id,
              ...(args.query?.trim() ? { query: args.query.trim() } : {}),
              limit,
              scan: args.scan ?? 20,
              budgetMs: FIND_SESSIONS_BUDGET_MS,
            }),
          ),
        );
        const [only] = results;
        const result = results.length === 1 && only ? only : mergeSearchResults(results, limit);

        const payload = fitToBudget(
          {
            project: {
              id: project.id,
              ...(group.length > 1 ? { ids: group.map((member) => member.id) } : {}),
              name: projectName(project),
            },
            ...(args.query?.trim() ? { query: args.query.trim() } : {}),
            scanned: result.scanned,
            partial: result.partial,
            ...(result.scan_errors ? { scan_errors: result.scan_errors } : {}),
            ...(result.scan_error ? { scan_error: result.scan_error.slice(0, 160) } : {}),
            sessions: result.sessions,
          },
          FIND_SESSIONS_MAX_CHARS,
        );
        return jsonResult(payload, { compact: true, structured: false });
      } catch (error) {
        ctx.logger.error("find_sessions failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(asBridgeError(error), rid);
      }
    },
  );
}
