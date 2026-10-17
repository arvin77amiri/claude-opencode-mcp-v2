import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import type { FileDiff } from "../../opencode/api-types.js";
import type { DiffFileSummary } from "../../types/index.js";
import { findGitRoot } from "../../util/git.js";
import { requestId, truncate } from "../../util/text.js";
import { type AppContext, assertSession, loadWorkspaceConfig } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

function normalizeStatus(status: string | undefined): DiffFileSummary["status"] {
  switch (status) {
    case "added":
    case "deleted":
    case "renamed":
    case "modified":
      return status;
    default:
      return status ? "unknown" : "modified";
  }
}

function renderPatch(entry: FileDiff): string {
  if (entry.patch?.trim()) return entry.patch.endsWith("\n") ? entry.patch : `${entry.patch}\n`;
  return `diff --git a/${entry.file} b/${entry.file}\n@@ +${entry.additions} -${entry.deletions} @@\n`;
}

export function registerGetDiff(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_diff",
    {
      title: "Inspect changes made in a session",
      description:
        "Return the file changes made by a delegated session, as reported by OpenCode (GET /api/session/{id}/diff).",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { session_id: string }) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        const config = await loadWorkspaceConfig(ctx, session.cwd);
        const client = ctx.manager.existingClient();
        if (!client) {
          throw new BridgeError(
            "DIFF_UNAVAILABLE",
            "No OpenCode server is connected, so the session diff cannot be read.",
            { details: { session_id: session.id, cwd: session.cwd } },
          );
        }

        let entries: FileDiff[];
        try {
          entries = await client.diff(session.id);
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError(
            "DIFF_UNAVAILABLE",
            `OpenCode could not return the diff: ${error instanceof Error ? error.message : String(error)}`,
            { details: { session_id: session.id } },
          );
        }
        if (entries.length === 0) {
          const inGitRepo = (await findGitRoot(session.cwd)) !== null;
          throw new BridgeError(
            "DIFF_UNAVAILABLE",
            inGitRepo
              ? "No file changes are available for this session."
              : `No file changes are available for this session. ${session.cwd} is not a git repository, and OpenCode only reports session diffs inside one: run \`git init\` there to enable get_diff, or inspect the files directly.`,
            {
              details: { session_id: session.id, cwd: session.cwd, git_repository: inGitRepo },
            },
          );
        }

        const files: DiffFileSummary[] = entries.map((entry) => ({
          file: entry.file,
          additions: entry.additions,
          deletions: entry.deletions,
          status: normalizeStatus(entry.status),
        }));
        const truncated = truncate(entries.map(renderPatch).join("\n"), config.limits.diffChars);
        return jsonResult({
          session_id: session.id,
          cwd: session.cwd,
          source: "opencode",
          files,
          diff: truncated.text,
          truncated: truncated.truncated,
        });
      } catch (error) {
        ctx.logger.error("get_diff failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
