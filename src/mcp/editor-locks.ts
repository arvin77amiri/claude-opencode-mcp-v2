import { BridgeError } from "../errors.js";
import { isPathInside } from "../security/paths.js";

interface EditorRun {
  cwd: string;
  sessionId: string;
}

/**
 * Editing runs in progress, by workspace. Two agents editing the same tree
 * overwrite each other, and the git-baseline diff then blames one for the
 * other's changes, so a second editing run on an overlapping cwd (the same
 * directory, a parent or a child) is refused with WORKSPACE_BUSY.
 *
 * Per bridge process: another Claude Code session with its own bridge is not seen.
 */
export class EditorLocks {
  private readonly runs = new Set<EditorRun>();

  /** The editing run that overlaps `cwd`, if any. */
  holder(cwd: string): EditorRun | null {
    for (const run of this.runs) {
      if (isPathInside(run.cwd, cwd) || isPathInside(cwd, run.cwd)) return run;
    }
    return null;
  }

  assertFree(cwd: string): void {
    const holder = this.holder(cwd);
    if (holder) throw workspaceBusy(cwd, holder);
  }

  /** Register an editing run; returns its release function. */
  acquire(cwd: string, sessionId: string): () => void {
    this.assertFree(cwd);
    const run: EditorRun = { cwd, sessionId };
    this.runs.add(run);
    return () => {
      this.runs.delete(run);
    };
  }
}

function workspaceBusy(cwd: string, holder: EditorRun): BridgeError {
  return new BridgeError(
    "WORKSPACE_BUSY",
    `Session ${holder.sessionId} is already editing ${holder.cwd}. Wait for it to finish, abort it with abort_session, or run this agent with allow_edits: false.`,
    {
      details: { cwd, busy_cwd: holder.cwd, busy_session_id: holder.sessionId },
      retryable: true,
    },
  );
}
