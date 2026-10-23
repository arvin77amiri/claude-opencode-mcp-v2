import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import {
  createTaskWorktree,
  mergeTaskWorktree,
  removeLeftoverDir,
  removeTaskWorktree,
} from "../../src/workspace/worktree.js";

const tempDirs: string[] = [];

/** Simulates a directory held open (EBUSY on Windows) with an immutable file; needs root + chattr. */
function tryChattr(): boolean {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-chattr-"));
    const file = path.join(dir, "f");
    fs.writeFileSync(file, "");
    execFileSync("chattr", ["+i", file], { stdio: "ignore" });
    let held = false;
    try {
      fs.rmSync(file);
    } catch {
      held = true;
    }
    execFileSync("chattr", ["-i", file], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
    return held;
  } catch {
    return false;
  }
}
const canLock = tryChattr();
const lock = (file: string) => execFileSync("chattr", ["+i", file]);
const unlock = (file: string) => execFileSync("chattr", ["-i", file]);
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const dir = await tempDir("co-wt-repo-");
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.writeFileSync(path.join(dir, "pkg", "b.txt"), "b\n");
  g(dir, "add", "-A");
  g(dir, ...ID, "commit", "-qm", "init");
  return dir;
}

beforeEach(async () => {
  process.env.CLAUDE_OPENCODE_WORKTREE_DIR = await tempDir("co-wt-base-");
});

afterEach(async () => {
  delete process.env.CLAUDE_OPENCODE_WORKTREE_DIR;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BridgeError);
  await promise.catch((error: BridgeError) => expect(error.code).toBe(code));
}

describe("task worktrees", () => {
  it("creates a worktree outside the repo on a new branch and maps a sub-directory cwd", async () => {
    const root = await repo();
    const wt = await createTaskWorktree({
      cwd: path.join(root, "pkg"),
      key: "ses_1",
      agent: "coder",
    });
    expect(wt.branch).toBe("oc/coder/ses_1");
    expect(wt.baseBranch).toBe("main");
    expect(wt.path.startsWith(root)).toBe(false);
    expect(wt.cwd).toBe(path.join(wt.path, "pkg"));
    expect(fs.readFileSync(path.join(wt.cwd, "b.txt"), "utf8")).toBe("b\n");
    expect(g(root, "branch", "--list", "oc/*").trim()).toContain("oc/coder/ses_1");
  });

  it("refuses non-git directories, unborn repos and dirty repos", async () => {
    const plain = await tempDir("co-wt-plain-");
    await expectCode(
      createTaskWorktree({ cwd: plain, key: "k", agent: "coder" }),
      "NOT_GIT_REPOSITORY",
    );

    const unborn = await tempDir("co-wt-unborn-");
    g(unborn, "init", "-q");
    await expectCode(
      createTaskWorktree({ cwd: unborn, key: "k", agent: "coder" }),
      "NOT_GIT_REPOSITORY",
    );

    const root = await repo();
    fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
    await expectCode(
      createTaskWorktree({ cwd: root, key: "k", agent: "coder" }),
      "WORKSPACE_DIRTY",
    );
  });

  it("allows untracked files in the user's checkout", async () => {
    const root = await repo();
    fs.writeFileSync(path.join(root, "notes.txt"), "mine\n");
    const wt = await createTaskWorktree({ cwd: root, key: "k", agent: "coder" });
    expect(fs.existsSync(path.join(wt.path, "notes.txt"))).toBe(false);
  });

  it("squashes the agent's work onto the base branch as one commit and cleans up", async () => {
    const root = await repo();
    const wt = await createTaskWorktree({ cwd: root, key: "ses_2", agent: "coder" });
    fs.writeFileSync(path.join(wt.path, "a.txt"), "two\n");
    g(wt.path, "add", "-A");
    g(wt.path, ...ID, "commit", "-qm", "agent step 1");
    fs.writeFileSync(path.join(wt.path, "new.txt"), "new\n"); // left uncommitted by the agent

    // The base branch may move on while the agent works.
    fs.writeFileSync(path.join(root, "pkg", "b.txt"), "b2\n");
    g(root, ...ID, "commit", "-qam", "user work");

    const before = Number(g(root, "rev-list", "--count", "HEAD").trim());
    const outcome = await mergeTaskWorktree(wt, "coder: update a");
    expect(outcome.status).toBe("merged");
    if (outcome.status === "merged") expect(outcome.files.sort()).toEqual(["a.txt", "new.txt"]);
    expect(Number(g(root, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("coder: update a");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(fs.readFileSync(path.join(root, "pkg", "b.txt"), "utf8")).toBe("b2\n");
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(g(root, "branch", "--list", "oc/*").trim()).toBe("");
  });

  it("reports an empty merge when the agent changed nothing", async () => {
    const root = await repo();
    const wt = await createTaskWorktree({ cwd: root, key: "ses_3", agent: "coder" });
    const head = g(root, "rev-parse", "HEAD");
    expect((await mergeTaskWorktree(wt, "nothing")).status).toBe("empty");
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("restores the checkout and keeps the worktree on conflict", async () => {
    const root = await repo();
    const wt = await createTaskWorktree({ cwd: root, key: "ses_4", agent: "coder" });
    fs.writeFileSync(path.join(wt.path, "a.txt"), "agent\n");
    fs.writeFileSync(path.join(root, "a.txt"), "user\n");
    g(root, ...ID, "commit", "-qam", "user edit");
    const head = g(root, "rev-parse", "HEAD");

    const outcome = await mergeTaskWorktree(wt, "conflicting");
    expect(outcome).toEqual({ status: "conflict", files: ["a.txt"] });
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
    expect(g(root, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("user\n");
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("refuses to merge into a dirty checkout or a different branch", async () => {
    const root = await repo();
    const wt = await createTaskWorktree({ cwd: root, key: "ses_5", agent: "coder" });
    fs.writeFileSync(path.join(wt.path, "new.txt"), "x\n");

    fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
    await expectCode(mergeTaskWorktree(wt, "m"), "WORKSPACE_DIRTY");
    g(root, "checkout", "-q", "--", "a.txt");

    g(root, "checkout", "-q", "-b", "other");
    await expectCode(mergeTaskWorktree(wt, "m"), "INVALID_ARGUMENT");
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("discards the worktree and branch without touching the checkout", async () => {
    const root = await repo();
    const head = g(root, "rev-parse", "HEAD");
    const wt = await createTaskWorktree({ cwd: root, key: "ses_6", agent: "coder" });
    fs.writeFileSync(path.join(wt.path, "a.txt"), "throwaway\n");
    await removeTaskWorktree(wt);
    await removeTaskWorktree(wt); // idempotent
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(g(root, "branch", "--list", "oc/*").trim()).toBe("");
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it.skipIf(!canLock)(
    "reports a locked worktree as not removed (no throw) and removes it once unlocked",
    async () => {
      const root = await repo();
      const wt = await createTaskWorktree({ cwd: root, key: "ses_7", agent: "coder" });
      fs.writeFileSync(path.join(wt.path, "a.txt"), "agent\n");
      const locked = path.join(wt.path, "held.txt");
      fs.writeFileSync(locked, "held\n");
      lock(locked);
      try {
        // Merge succeeds even though the worktree cannot be deleted afterwards.
        const outcome = await mergeTaskWorktree(wt, "locked merge");
        expect(outcome.status).toBe("merged");
        if (outcome.status === "merged") {
          expect(outcome.cleanup.removed).toBe(false);
          expect(outcome.cleanup.error).toBeTruthy();
        }
        expect(g(root, "log", "-1", "--format=%s").trim()).toBe("locked merge");
        expect(fs.existsSync(wt.path)).toBe(true);
      } finally {
        unlock(locked);
      }
      expect(await removeTaskWorktree(wt, [0])).toEqual({ removed: true });
      expect(fs.existsSync(wt.path)).toBe(false);
      expect(g(root, "branch", "--list", "oc/*").trim()).toBe("");
    },
  );

  it.skipIf(!canLock)(
    "removes worktree and branch when only the empty folder stays held, and reports it as leftover",
    async () => {
      const root = await repo();
      const wt = await createTaskWorktree({ cwd: root, key: "ses_8", agent: "coder" });
      fs.writeFileSync(path.join(wt.path, "a.txt"), "agent\n");
      // Immutable parent: the folder's contents can go, the folder itself cannot (like EBUSY).
      const parent = path.dirname(wt.path);
      lock(parent);
      let outcome: Awaited<ReturnType<typeof mergeTaskWorktree>>;
      try {
        outcome = await mergeTaskWorktree(wt, "leftover merge");
      } finally {
        unlock(parent);
      }
      expect(outcome.status).toBe("merged");
      if (outcome.status === "merged") {
        expect(outcome.cleanup).toEqual({ removed: true, leftoverDir: wt.path });
      }
      expect(fs.readdirSync(wt.path)).toEqual([]);
      expect(g(root, "branch", "--list", "oc/*").trim()).toBe("");
      expect(g(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
      expect(await removeLeftoverDir(wt.path)).toBe(true);
      expect(fs.existsSync(wt.path)).toBe(false);
    },
  );

  it("never deletes a leftover folder that has content", async () => {
    const dir = await tempDir("co-wt-left-");
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    expect(await removeLeftoverDir(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
  });
});
