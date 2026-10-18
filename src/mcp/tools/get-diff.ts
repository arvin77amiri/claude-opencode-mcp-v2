import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import type { FileDiff } from "../../opencode/api-types.js";
import { diffSinceBaseline, findGitRoot, lateGitBaseline } from "../../util/git.js";
import { requestId, truncate } from "../../util/text.js";
import {
  type AppContext,
  assertSession,
  loadWorkspaceConfig,
  summarizeDiffEntry,
} from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

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
        "Return the file changes made by a delegated session, as reported by OpenCode, or, when OpenCode reports none, a git diff against the workspace state captured when the session was created.",
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

        let entries: FileDiff[] = [];
        let opencodeError: string | undefined;
        if (client) {
          try {
            entries = await client.diff(session.id);
          } catch (error) {
            opencodeError = error instanceof Error ? error.message : String(error);
          }
        } else {
          opencodeError = "No OpenCode server is connected.";
        }

        const lateBaseline =
          entries.length === 0 && !session.gitBaseline ? await lateGitBaseline(session.cwd) : null;
        const baseline = session.gitBaseline ?? lateBaseline;
        if (entries.length === 0 && baseline) {
          const git = await diffSinceBaseline(session.cwd, baseline, {
            maxPatchChars: config.limits.diffChars,
          });
          if (git.files.length > 0) {
            return jsonResult({
              session_id: session.id,
              cwd: session.cwd,
              source: "git",
              files: git.files,
              diff: git.patch,
              truncated: git.truncated,
              ...(lateBaseline
                ? {
                    note: `${git.note ? `${git.note} ` : ""}The workspace became a git repository after this session was created, so the diff is against HEAD and includes any earlier uncommitted work.`,
                  }
                : git.note
                  ? { note: git.note }
                  : {}),
            });
          }
        }
        if (entries.length === 0 && opencodeError) {
          throw new BridgeError(
            "DIFF_UNAVAILABLE",
            `OpenCode could not return the diff: ${opencodeError}`,
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

        const files = entries.map(summarizeDiffEntry);
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
