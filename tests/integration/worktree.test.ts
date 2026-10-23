import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode, type FakePromptRequest } from "../helpers/fake-opencode.js";

let fake: FakeOpenCode;
let client: Client;
let server: McpServer;
const tempDirs: string[] = [];
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

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

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repo(): Promise<string> {
  const dir = await tempDir("co-wti-repo-");
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g(dir, "add", "-A");
  g(dir, ...ID, "commit", "-qm", "init");
  return dir;
}

/** Fake agent: an editing prompt appends a line to a.txt and writes <name>.txt in its directory. */
function editingAgent(request: FakePromptRequest): { text: string } {
  const name = /WRITE (\w+)/.exec(request.text)?.[1];
  if (name) {
    fs.appendFileSync(path.join(request.directory, "a.txt"), `${name}\n`);
    fs.writeFileSync(path.join(request.directory, `${name}.txt`), `${name}\n`);
  }
  return { text: `done in ${request.directory}` };
}

async function setup(): Promise<void> {
  process.env.CLAUDE_OPENCODE_WORKTREE_DIR = await tempDir("co-wti-wt-");
  fake = new FakeOpenCode({ onPrompt: editingAgent });
  const baseUrl = await fake.listen();
  const stateDir = await tempDir("co-wti-state-");
  const config = BridgeConfigSchema.parse({ opencode: { url: baseUrl, autoStart: false } });
  const logger = createLogger({ level: "silent" });
  server = createMcpServer({
    logger,
    manager: new OpenCodeManager({ logger }),
    registry: new SessionRegistry(path.join(stateDir, "sessions.json"), logger),
    globalConfig: config,
    env: process.env,
    stateDir,
    loadProjectConfig: async () => ({ config, sources: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { ...JSON.parse(content[0]?.text ?? "{}"), isError: result.isError === true };
}

beforeEach(setup);

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await fake?.close().catch(() => undefined);
  delete process.env.CLAUDE_OPENCODE_WORKTREE_DIR;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("worktree isolation", () => {
  it("runs a coder in its own worktree, diffs it and merges it as one commit", async () => {
    const root = await repo();
    const result = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE alpha" });
    expect(result.status).toBe("completed");
    expect(result.worktree.state).toBe("active");
    expect(result.worktree.branch).toMatch(/^oc\/coder\//);
    expect(result.cwd).toBe(result.worktree.path);
    expect(result.cwd.startsWith(root)).toBe(false);

    // The user's checkout is untouched while the work waits for review.
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(root, "alpha.txt"))).toBe(false);

    const diff = await call("get_diff", { session_id: result.session_id });
    expect(diff.source).toBe("worktree");
    expect(diff.files.map((f: { file: string }) => f.file).sort()).toEqual(["a.txt", "alpha.txt"]);
    expect(diff.diff).toContain("+alpha");

    const commits = Number(g(root, "rev-list", "--count", "HEAD").trim());
    const merged = await call("merge_task", {
      session_id: result.session_id,
      message: "add alpha",
    });
    expect(merged.isError).toBe(false);
    expect(merged.merged).toBe(true);
    expect(merged.worktree.state).toBe("merged");
    expect(Number(g(root, "rev-list", "--count", "HEAD").trim())).toBe(commits + 1);
    expect(g(root, "log", "-1", "--format=%s").trim()).toBe("add alpha");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\nalpha\n");
    expect(fs.existsSync(result.worktree.path)).toBe(false);

    // After the merge get_diff shows the merged commit, and the session is closed.
    const after = await call("get_diff", { session_id: result.session_id });
    expect(after.diff).toContain("+alpha");
    const again = await call("send_message", { session_id: result.session_id, message: "more" });
    expect(again.isError).toBe(true);
    expect(again.code ?? again.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("lets two coders work in parallel on one repo and discards one", async () => {
    const root = await repo();
    const [a, b] = await Promise.all([
      call("delegate_task", { cwd: root, agent: "coder", task: "WRITE first" }),
      call("delegate_task", { cwd: root, agent: "coder", task: "WRITE second" }),
    ]);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(a.worktree.path).not.toBe(b.worktree.path);

    const discarded = await call("discard_task", { session_id: b.session_id });
    expect(discarded.discarded).toBe(true);
    expect(fs.existsSync(b.worktree.path)).toBe(false);
    expect(g(root, "branch", "--list", b.worktree.branch).trim()).toBe("");

    const merged = await call("merge_task", { session_id: a.session_id });
    expect(merged.merged).toBe(true);
    expect(fs.existsSync(path.join(root, "first.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "second.txt"))).toBe(false);
  });

  it("keeps follow-up messages in the same worktree", async () => {
    const root = await repo();
    const first = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE one" });
    const second = await call("send_message", {
      session_id: first.session_id,
      message: "WRITE two",
    });
    expect(second.status).toBe("completed");
    expect(second.worktree.path).toBe(first.worktree.path);
    const diff = await call("get_diff", { session_id: first.session_id });
    expect(diff.files.map((f: { file: string }) => f.file).sort()).toEqual([
      "a.txt",
      "one.txt",
      "two.txt",
    ]);
  });

  it("refuses editing in a dirty repo or outside git, but read-only agents still run there", async () => {
    const root = await repo();
    fs.writeFileSync(path.join(root, "a.txt"), "uncommitted\n");
    const dirty = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE x" });
    expect(dirty.isError).toBe(true);
    expect(JSON.stringify(dirty)).toContain("WORKSPACE_DIRTY");

    const plain = await tempDir("co-wti-plain-");
    const noGit = await call("delegate_task", { cwd: plain, agent: "coder", task: "WRITE x" });
    expect(noGit.isError).toBe(true);
    expect(JSON.stringify(noGit)).toContain("NOT_GIT_REPOSITORY");

    const research = await call("delegate_task", { cwd: plain, agent: "researcher", task: "look" });
    expect(research.status).toBe("completed");
    expect(research.worktree).toBeUndefined();
    expect(research.cwd).toBe(plain);
  });

  it("does not let a read-only session be granted edits later", async () => {
    const root = await repo();
    const ro = await call("delegate_task", { cwd: root, agent: "researcher", task: "look" });
    const upgraded = await call("send_message", {
      session_id: ro.session_id,
      message: "WRITE y",
      allow_edits: true,
    });
    expect(upgraded.isError).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("reports a merge conflict and leaves the checkout and worktree intact", async () => {
    const root = await repo();
    const task = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE gamma" });
    fs.writeFileSync(path.join(root, "a.txt"), "user rewrote this\n");
    g(root, ...ID, "commit", "-qam", "user edit");
    const head = g(root, "rev-parse", "HEAD");

    const merged = await call("merge_task", { session_id: task.session_id });
    expect(merged.isError).toBe(true);
    expect(JSON.stringify(merged)).toContain("MERGE_CONFLICT");
    expect(g(root, "rev-parse", "HEAD")).toBe(head);
    expect(g(root, "status", "--porcelain").trim()).toBe("");
    expect(fs.existsSync(task.worktree.path)).toBe(true);

    const discarded = await call("discard_task", { session_id: task.session_id });
    expect(discarded.discarded).toBe(true);
  });

  it("survives a failed merge_task (no crash) and keeps serving", async () => {
    const root = await repo();
    const task = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE delta" });
    fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
    const refused = await call("merge_task", { session_id: task.session_id });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("WORKSPACE_DIRTY");
    g(root, "checkout", "-q", "--", "a.txt");

    const listed = await call("list_agents", { cwd: root });
    expect(listed.isError).toBe(false);
    const merged = await call("merge_task", { session_id: task.session_id });
    expect(merged.merged).toBe(true);
  });

  it.skipIf(!canLock)(
    "reports a locked worktree as cleanup_pending after a successful merge and sweeps it later",
    async () => {
      const root = await repo();
      const task = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE eps" });
      const held = path.join(task.worktree.path, "held.txt");
      fs.writeFileSync(held, "x\n");
      execFileSync("chattr", ["+i", held]);
      let merged: any;
      try {
        merged = await call("merge_task", { session_id: task.session_id, message: "eps" });
      } finally {
        execFileSync("chattr", ["-i", held]);
      }
      expect(merged.isError).toBe(false);
      expect(merged.merged).toBe(true);
      expect(merged.cleanup_pending).toBe(true);
      expect(merged.worktree.state).toBe("merged");
      expect(g(root, "log", "-1", "--format=%s").trim()).toBe("eps");

      // The next merge/discard sweeps pending cleanups in the background.
      const other = await call("delegate_task", { cwd: root, agent: "coder", task: "WRITE zeta" });
      await call("discard_task", { session_id: other.session_id });
      for (let i = 0; i < 50 && fs.existsSync(task.worktree.path); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(fs.existsSync(task.worktree.path)).toBe(false);
      expect(g(root, "branch", "--list", "oc/*").trim()).toBe("");
    },
  );
});
