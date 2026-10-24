import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError } from "../../errors.js";
import type { FileDiff } from "../../opencode/api-types.js";
import {
  diffSinceBaseline,
  findGitRoot,
  lateGitBaseline,
  parseUnifiedDiff,
  runGit,
} from "../../util/git.js";
import { requestId, truncate } from "../../util/text.js";
import {
  type AppContext,
  assertSession,
  loadWorkspaceConfig,
  summarizeDiffEntry,
} from "../execute.js";
import { pickSessionId, type SessionArgs, sessionInputFor } from "../session-arg.js";
import { worktreeSummary } from "../session-utils.js";
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
        "Return the file changes made by a delegated session. For a worktree (editing) session: the git diff of its branch against the commit it started from, committed or not, i.e. exactly what merge_task would apply (after a merge: the merged commit). Otherwise: OpenCode's session diff, or a git diff against the workspace state captured when the session was created.",
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
        const config = await loadWorkspaceConfig(ctx, session.originCwd ?? session.cwd);

        const wt = session.worktree;
        if (wt) {
          if (wt.state === "discarded") {
            throw new BridgeError(
              "DIFF_UNAVAILABLE",
              `Session ${session.id} was discarded; its worktree and branch are gone.`,
              { details: { session_id: session.id } },
            );
          }
          let git: { patch: string; files: unknown[]; truncated: boolean; note?: string };
          if (wt.state === "merged" && wt.mergedCommit) {
            const shown = await runGit(
              wt.repoRoot,
              ["diff", "--no-color", "--no-ext-diff", `${wt.mergedCommit}^`, wt.mergedCommit, "--"],
              { timeoutMs: 20_000 },
            );
            if (shown.failed) {
              throw new BridgeError(
                "DIFF_UNAVAILABLE",
                `Could not read merged commit ${wt.mergedCommit}: ${shown.stderr.trim()}`,
              );
            }
            const t = truncate(shown.stdout, config.limits.diffChars);
            git = { patch: t.text, files: parseUnifiedDiff(shown.stdout), truncated: t.truncated };
          } else {
            git = await diffSinceBaseline(
              wt.path,
              { head: wt.baseCommit, stashRef: null, untracked: [], unborn: false, dirty: false },
              { maxPatchChars: config.limits.diffChars },
            );
          }
          return jsonResult({
            session_id: session.id,
            cwd: session.cwd,
            source: "worktree",
            files: git.files,
            diff: git.patch,
            truncated: git.truncated,
            ...(git.note ? { note: git.note } : {}),
            ...worktreeSummary(session),
          });
        }
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
