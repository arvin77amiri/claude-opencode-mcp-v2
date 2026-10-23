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

export type MergeOutcome =
  | { status: "merged"; commit: string; files: string[] }
  | { status: "empty" }
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
    await removeTaskWorktree(wt);
    return { status: "empty" };
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
    await removeTaskWorktree(wt);
    return { status: "empty" };
  }
  await git(wt.repoRoot, await commitArgs(wt.repoRoot, message), "git commit");
  const commit = (await git(wt.repoRoot, ["rev-parse", "HEAD"], "git rev-parse")).trim();
  await removeTaskWorktree(wt);
  return { status: "merged", commit, files };
}

/** Delete the worktree and its branch. Safe to call when either is already gone. */
export async function removeTaskWorktree(wt: TaskWorktree): Promise<void> {
  if (fs.existsSync(wt.path)) {
    const removed = await runGit(wt.repoRoot, ["worktree", "remove", "--force", wt.path], {
      timeoutMs: 120_000,
    });
    if (removed.failed) await fs.promises.rm(wt.path, { recursive: true, force: true });
  }
  await runGit(wt.repoRoot, ["worktree", "prune"], { timeoutMs: 30_000 });
  await runGit(wt.repoRoot, ["branch", "-D", wt.branch], { timeoutMs: 15_000 });
}
