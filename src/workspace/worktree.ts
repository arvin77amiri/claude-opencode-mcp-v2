/**
 * Per-task git worktree isolation.
 *
 * Every editing task runs in its own worktree on its own branch, created
 * OUTSIDE the repository (under the bridge state directory) from the commit
 * the base branch is on. The user's checkout is never touched while the agent
 * works. When the orchestrator accepts the work, the bridge (never the agent)
 * squashes the task branch onto the base branch as one commit; when it
 * rejects the work, the worktree and branch are deleted.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { findGitRoot, runGit } from "../util/git.js";
import { stateDirectory } from "../util/logger.js";

/** Persisted description of a task worktree (stored on the session). */
export interface TaskWorktree {
  /** Canonical root of the user's repository. */
  repoRoot: string;
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Directory the agent works in: the worktree plus the cwd's offset inside the repo. */
  cwd: string;
  /** Task branch, e.g. oc/coder/ses_abc123. */
  branch: string;
  /** Branch the task started from and will be merged into. */
  baseBranch: string;
  /** Commit the task branch was created from. */
  baseCommit: string;
}

export interface CreateTaskWorktreeInput {
  /** The validated workspace directory the task was requested for. */
  cwd: string;
  /** Short unique key (usually derived from the session id). */
  key: string;
  /** Agent name, used in the branch name. */
  agent: string;
}

/** Result of deleting a worktree + branch. Never thrown: cleanup is best effort. */
export interface CleanupResult {
  /** The worktree is unregistered and its branch deleted. */
  removed: boolean;
  /** An empty folder that could not be deleted yet (held open on Windows); harmless. */
  leftoverDir?: string;
  /** Why the worktree directory or branch is still there (e.g. EBUSY on Windows). */
  error?: string;
}

export type MergeOutcome =
  | { status: "merged"; commit: string; files: string[]; cleanup: CleanupResult }
  | { status: "empty"; cleanup: CleanupResult }
  | { status: "conflict"; files: string[] };

const BRANCH_PREFIX = "oc";
const BRIDGE_IDENTITY = [
  "-c",
  "user.name=OpenCode bridge",
  "-c",
  "user.email=bridge@opencode.local",
];

/** Directory that holds every task worktree. Override with CLAUDE_OPENCODE_WORKTREE_DIR. */
export function worktreeBaseDir(): string {
  const override = process.env.CLAUDE_OPENCODE_WORKTREE_DIR;
  if (override?.trim()) return path.resolve(override);
  return path.join(stateDirectory(), "worktrees");
}

function slug(value: string, max = 40): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".");
  return (cleaned || "task").slice(0, max);
}

function repoDirName(repoRoot: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return `${slug(path.basename(repoRoot), 30)}-${hash}`;
}

async function git(cwd: string, args: string[], what: string, timeoutMs = 30_000): Promise<string> {
  const result = await runGit(cwd, args, { timeoutMs });
  if (result.missing) {
    throw new BridgeError("NOT_GIT_REPOSITORY", "git is not installed or not on PATH.");
  }
  if (result.failed) {
    throw new BridgeError(
      "INTERNAL_ERROR",
      `${what} failed: ${result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`}`,
      { details: { cwd, args } },
    );
  }
  return result.stdout;
}

/** Tracked files with uncommitted changes (staged or not). Untracked files are ignored. */
export async function trackedChanges(repoRoot: string): Promise<string[]> {
  const out = await git(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "git status",
  );
  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function currentBranch(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    timeoutMs: 5_000,
  });
  if (result.failed) return null;
  return result.stdout.trim() || null;
}

async function hasIdentity(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["config", "user.email"], { timeoutMs: 5_000 });
  return !result.failed && result.stdout.trim() !== "";
}

async function commitArgs(cwd: string, message: string): Promise<string[]> {
  const identity = (await hasIdentity(cwd)) ? [] : BRIDGE_IDENTITY;
  return [...identity, "commit", "--no-verify", "-q", "-m", message];
}

/**
 * Create an isolated worktree for an editing task.
 *
 * Refuses (NOT_GIT_REPOSITORY / WORKSPACE_DIRTY / INVALID_ARGUMENT) when the
 * workspace is not a git repository, has no commits, is on a detached HEAD,
 * or has uncommitted changes to tracked files.
 */
export async function createTaskWorktree(input: CreateTaskWorktreeInput): Promise<TaskWorktree> {
  const repoRoot = await findGitRoot(input.cwd);
  if (!repoRoot) {
    throw new BridgeError(
      "NOT_GIT_REPOSITORY",
      `Editing tasks run in an isolated git worktree, but ${input.cwd} is not inside a git repository. Run \`git init\` and make a first commit there, or delegate without edits.`,
      { details: { cwd: input.cwd } },
    );
  }
  const realRoot = await fs.promises.realpath(repoRoot);

  const head = await runGit(realRoot, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 5_000 });
  if (head.failed) {
    throw new BridgeError(
      "NOT_GIT_REPOSITORY",
      `${realRoot} has no commits yet. Make a first commit before delegating an editing task.`,
      { details: { repo: realRoot } },
    );
  }
  const baseCommit = head.stdout.trim();

  const baseBranch = await currentBranch(realRoot);
  if (!baseBranch) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `${realRoot} is on a detached HEAD. Check out a branch before delegating an editing task.`,
      { details: { repo: realRoot } },
    );
  }

  const dirty = await trackedChanges(realRoot);
  if (dirty.length > 0) {
    throw new BridgeError(
      "WORKSPACE_DIRTY",
      `${realRoot} has uncommitted changes to ${dirty.length} tracked file(s). Commit or stash them first, so the agent's work cannot collide with yours.`,
      { details: { repo: realRoot, files: dirty.slice(0, 50) } },
    );
  }

  const key = slug(input.key, 48);
  const branch = `${BRANCH_PREFIX}/${slug(input.agent, 30)}/${key}`;
  const wtPath = path.join(worktreeBaseDir(), repoDirName(realRoot), key);
  await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });
  if (fs.existsSync(wtPath)) {
    throw new BridgeError("INTERNAL_ERROR", `Worktree path already exists: ${wtPath}`, {
      details: { path: wtPath },
    });
  }

  await git(
    realRoot,
    ["worktree", "add", "-q", "-b", branch, wtPath, baseCommit],
    "git worktree add",
    120_000,
  );
  const realWt = await fs.promises.realpath(wtPath);

  const realCwd = await fs.promises.realpath(input.cwd);
  const offset = path.relative(realRoot, realCwd);
  const cwd = offset && !offset.startsWith("..") ? path.join(realWt, offset) : realWt;
  await fs.promises.mkdir(cwd, { recursive: true });

  return { repoRoot: realRoot, path: realWt, cwd, branch, baseBranch, baseCommit };
}

/** Commit everything pending in the worktree (if anything). Returns true when a commit was made. */
export async function commitPending(wt: TaskWorktree, message: string): Promise<boolean> {
  await git(wt.path, ["add", "-A"], "git add");
  const staged = await runGit(wt.path, ["diff", "--cached", "--quiet"], { timeoutMs: 15_000 });
  if (!staged.failed) return false;
  await git(wt.path, await commitArgs(wt.path, message), "git commit");
  return true;
}

/**
 * Squash the task branch onto the base branch as a single commit, then
 * remove the worktree and branch. On conflict, the user's checkout is
 * restored to its pre-merge state and the worktree is kept for inspection.
 */
export async function mergeTaskWorktree(wt: TaskWorktree, message: string): Promise<MergeOutcome> {
  if (!fs.existsSync(wt.path)) {
    throw new BridgeError("INVALID_ARGUMENT", `The task worktree no longer exists: ${wt.path}`, {
      details: { path: wt.path },
    });
  }
  await commitPending(wt, `WIP: ${message}`);

  const ahead = (
    await git(
      wt.repoRoot,
      ["rev-list", "--count", `${wt.baseCommit}..${wt.branch}`],
      "git rev-list",
    )
  ).trim();
  if (ahead === "0") {
    return { status: "empty", cleanup: await removeTaskWorktree(wt) };
  }

  const branchNow = await currentBranch(wt.repoRoot);
  if (branchNow !== wt.baseBranch) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `The task started on branch ${wt.baseBranch}, but ${wt.repoRoot} is now on ${branchNow ?? "a detached HEAD"}. Check out ${wt.baseBranch} and merge again.`,
      { details: { base_branch: wt.baseBranch, current: branchNow } },
    );
  }
  const dirty = await trackedChanges(wt.repoRoot);
  if (dirty.length > 0) {
    throw new BridgeError(
      "WORKSPACE_DIRTY",
      `${wt.repoRoot} has uncommitted changes to ${dirty.length} tracked file(s). Commit or stash them, then merge again; the task worktree is kept.`,
      { details: { repo: wt.repoRoot, files: dirty.slice(0, 50) } },
    );
  }

  const merge = await runGit(wt.repoRoot, ["merge", "--squash", "--no-commit", wt.branch], {
    timeoutMs: 120_000,
  });
  if (merge.failed) {
    const unmerged = await runGit(wt.repoRoot, ["diff", "--name-only", "--diff-filter=U"], {
      timeoutMs: 15_000,
    });
    const files = unmerged.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    await runGit(wt.repoRoot, ["reset", "--merge"], { timeoutMs: 60_000 });
    if (files.length > 0 || /conflict/i.test(merge.stdout + merge.stderr)) {
      return { status: "conflict", files };
    }
    throw new BridgeError(
      "INTERNAL_ERROR",
      `git merge --squash failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
      { details: { branch: wt.branch } },
    );
  }

  const files = (await git(wt.repoRoot, ["diff", "--cached", "--name-only"], "git diff --cached"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) {
    // The base branch already contains identical changes.
    return { status: "empty", cleanup: await removeTaskWorktree(wt) };
  }
  await git(wt.repoRoot, await commitArgs(wt.repoRoot, message), "git commit");
  const commit = (await git(wt.repoRoot, ["rev-parse", "HEAD"], "git rev-parse")).trim();
  // The commit is made: from here on nothing may throw, cleanup is best effort.
  return { status: "merged", commit, files, cleanup: await removeTaskWorktree(wt) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delays between removal attempts. On Windows the OpenCode service can hold the
 * worktree directory open for a moment after its session goes idle (EBUSY). */
export const REMOVE_RETRY_DELAYS_MS = [0, 300, 800, 1_500, 2_500];

/**
 * Delete the worktree and its branch. Safe to call when either is already
 * gone. Never throws: when the directory stays locked (EBUSY/EPERM), returns
 * `{ removed: false }` and the caller records the cleanup as pending.
 */
export async function removeTaskWorktree(
  wt: TaskWorktree,
  delays: number[] = REMOVE_RETRY_DELAYS_MS,
): Promise<CleanupResult> {
  let lastError = "";
  for (const delay of delays) {
    // An empty directory is no longer a worktree: on Windows the OpenCode service can keep
    // a handle on the folder itself long after its session is idle (until the app restarts),
    // so waiting longer does not help. git cleanup goes ahead; the folder is retried later.
    if (!fs.existsSync(wt.path) || isEmptyDir(wt.path)) break;
    if (delay > 0) await sleep(delay);
    const removed = await runGit(wt.repoRoot, ["worktree", "remove", "--force", wt.path], {
      timeoutMs: 120_000,
    });
    if (!removed.failed && !fs.existsSync(wt.path)) break;
    lastError = removed.stderr.trim() || lastError;
    try {
      await fs.promises.rm(wt.path, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 200,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    if (fs.existsSync(wt.path) && !isEmptyDir(wt.path)) {
      return { removed: false, error: lastError || `could not remove ${wt.path}` };
    }
    // The worktree's .git file is gone, so prune unregisters it and the branch can go.
    await runGit(wt.repoRoot, ["worktree", "prune"], { timeoutMs: 30_000 });
    const branch = await runGit(wt.repoRoot, ["branch", "-D", wt.branch], { timeoutMs: 15_000 });
    const branchGone =
      !branch.failed ||
      (
        await runGit(wt.repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`], {
          timeoutMs: 5_000,
        })
      ).failed;
    if (!branchGone) {
      return {
        removed: false,
        error: branch.stderr.trim() || `could not delete branch ${wt.branch}`,
      };
    }
    if (fs.existsSync(wt.path)) {
      // Last chance for the empty folder; if it is still held, report it as a leftover.
      try {
        await fs.promises.rmdir(wt.path);
      } catch {
        return { removed: true, leftoverDir: wt.path };
      }
    }
    return { removed: true };
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Remove an empty leftover worktree folder. Returns true when it is gone. */
export async function removeLeftoverDir(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return true;
  if (!isEmptyDir(dir)) return false; // never delete a folder that has content
  try {
    await fs.promises.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}
