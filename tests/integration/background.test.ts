import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { BackgroundRuns } from "../../src/mcp/background.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode, type FakeOpenCodeOptions } from "../helpers/fake-opencode.js";

let fake: FakeOpenCode;
let client: Client;
let server: McpServer;
let background: BackgroundRuns;
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-bg-"));
  tempDirs.push(dir);
  return dir;
}

/** Fake server that counts how many prompts run at the same time. */
function concurrencyProbe(delayMs: number) {
  const probe = { running: 0, max: 0 };
  const fakeOptions: FakeOpenCodeOptions = {
    onPrompt: () => {
      probe.running += 1;
      probe.max = Math.max(probe.max, probe.running);
      return {
        text: "BG DONE",
        delayMs,
        onBeforeRespond: () => {
          probe.running -= 1;
        },
      };
    },
  };
  return { probe, fakeOptions };
}

async function setupApp(options: {
  fakeOptions?: FakeOpenCodeOptions;
  maxConcurrentRuns?: number;
}) {
  fake = new FakeOpenCode(options.fakeOptions);
  const baseUrl = await fake.listen();
  const stateDir = await tempDir();
  const config = BridgeConfigSchema.parse({
    opencode: { url: baseUrl, autoStart: false },
    // These suites cover the shared-workspace mode; worktree isolation has its own suite.
    worktrees: { enabled: false },
    limits: { maxConcurrentRuns: options.maxConcurrentRuns ?? 3 },
  });
  const logger = createLogger({ level: "silent" });
  background = new BackgroundRuns(logger);
  server = createMcpServer({
    logger,
    manager: new OpenCodeManager({ logger }),
    registry: new SessionRegistry(path.join(stateDir, "sessions.json"), logger),
    globalConfig: config,
    env: process.env,
    stateDir,
    background,
    loadProjectConfig: async () => ({ config, sources: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text: string }>)[0];
  return { isError: !!result.isError, body: JSON.parse(first?.text ?? "null") };
}

afterEach(async () => {
  await background?.abortAll(2_000);
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await fake?.close().catch(() => undefined);
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("background runs", () => {
  it("returns at once and delivers the full result through wait_session", async () => {
    const { fakeOptions } = concurrencyProbe(300);
    await setupApp({ fakeOptions });
    const cwd = await tempDir();

    const started = Date.now();
    const start = await call("delegate_task", { cwd, task: "map it", background: true });
    expect(Date.now() - started).toBeLessThan(300);
    expect(start.body).toMatchObject({ status: "running", background: true });
    expect(start.body.session_id).toMatch(/^ses_/);

    const early = await call("wait_session", { session_id: start.body.session_id, timeout: 0 });
    expect(early.body).toMatchObject({ done: false, status: "running" });

    const done = await call("wait_session", { session_id: start.body.session_id, timeout: 10_000 });
    expect(done.isError).toBe(false);
    expect(done.body).toMatchObject({ done: true, status: "completed", summary: "BG DONE" });

    const session = await call("get_session", { session_id: start.body.session_id });
    expect(session.body.status).toBe("completed");
    expect(session.body.background.state).toBe("done");
  });

  it("never runs more than maxConcurrentRuns at once and queues the rest", async () => {
    const { probe, fakeOptions } = concurrencyProbe(300);
    await setupApp({ fakeOptions, maxConcurrentRuns: 2 });

    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const cwd = await tempDir();
      const r = await call("delegate_task", { cwd, task: `job ${i}`, background: true });
      ids.push(r.body.session_id);
      if (i >= 2) expect(r.body).toMatchObject({ status: "queued", queue_position: i - 1 });
    }

    const queued = await call("get_session", { session_id: ids[3] });
    expect(queued.body.status).toBe("queued");

    for (const id of ids) {
      const r = await call("wait_session", { session_id: id, timeout: 15_000 });
      expect(r.body).toMatchObject({ done: true, status: "completed" });
    }
    expect(probe.max).toBe(2);
    expect(fake.prompts).toHaveLength(4);
  });

  it("makes a blocking call wait for a slot instead of failing", async () => {
    const { probe, fakeOptions } = concurrencyProbe(300);
    await setupApp({ fakeOptions, maxConcurrentRuns: 1 });
    const first = await call("delegate_task", {
      cwd: await tempDir(),
      task: "bg",
      background: true,
    });
    const blocking = await call("delegate_task", { cwd: await tempDir(), task: "fg" });
    expect(blocking.body.status).toBe("completed");
    expect(probe.max).toBe(1);
    await call("wait_session", { session_id: first.body.session_id, timeout: 10_000 });
  });

  it("cancels a queued run with abort_session without it ever reaching OpenCode", async () => {
    const { fakeOptions } = concurrencyProbe(400);
    await setupApp({ fakeOptions, maxConcurrentRuns: 1 });
    const first = await call("delegate_task", {
      cwd: await tempDir(),
      task: "a",
      background: true,
    });
    const second = await call("delegate_task", {
      cwd: await tempDir(),
      task: "b",
      background: true,
    });
    expect(second.body.status).toBe("queued");

    const aborted = await call("abort_session", { session_id: second.body.session_id });
    expect(aborted.body).toMatchObject({ aborted: true, was: "queued" });

    const waited = await call("wait_session", {
      session_id: second.body.session_id,
      timeout: 5_000,
    });
    expect(waited.body).toMatchObject({ done: true, status: "aborted" });
    expect(waited.body.error.code).toBe("AGENT_ABORTED");

    await call("wait_session", { session_id: first.body.session_id, timeout: 10_000 });
    expect(fake.prompts).toHaveLength(1);
  });

  it("interrupts a running background run on abort_session and on shutdown", async () => {
    await setupApp({ fakeOptions: { onPrompt: () => ({ text: "late", delayMs: 20_000 }) } });
    const a = await call("delegate_task", { cwd: await tempDir(), task: "a", background: true });
    const b = await call("delegate_task", { cwd: await tempDir(), task: "b", background: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await call("abort_session", { session_id: a.body.session_id });
    const waited = await call("wait_session", { session_id: a.body.session_id, timeout: 5_000 });
    expect(waited.body.done).toBe(true);
    expect(fake.sessions.get(a.body.session_id)?.interrupted).toBe(true);

    await background.abortAll(5_000);
    expect(fake.sessions.get(b.body.session_id)?.interrupted).toBe(true);
    const after = await call("get_session", { session_id: b.body.session_id });
    expect(after.body.status).toBe("aborted");
  });

  it("refuses a second editing run on the same workspace even while the first is queued", async () => {
    const { fakeOptions } = concurrencyProbe(300);
    await setupApp({ fakeOptions, maxConcurrentRuns: 1 });
    const cwd = await tempDir();
    await call("delegate_task", { cwd: await tempDir(), task: "busy", background: true });
    const coder = await call("delegate_task", { cwd, agent: "coder", task: "x", background: true });
    expect(coder.body.status).toBe("queued");

    const second = await call("delegate_task", {
      cwd,
      agent: "coder",
      task: "y",
      background: true,
    });
    expect(second.isError).toBe(true);
    expect(second.body.error.code).toBe("WORKSPACE_BUSY");
  });

  it("refuses send_message while the session's background run is in progress", async () => {
    const { fakeOptions } = concurrencyProbe(500);
    await setupApp({ fakeOptions });
    const start = await call("delegate_task", {
      cwd: await tempDir(),
      task: "a",
      background: true,
    });
    const follow = await call("send_message", {
      session_id: start.body.session_id,
      message: "more",
    });
    expect(follow.isError).toBe(true);
    expect(follow.body.error.code).toBe("INVALID_ARGUMENT");
    await call("wait_session", { session_id: start.body.session_id, timeout: 10_000 });
  });

  it("reports the stored state for a session without a background run", async () => {
    const { fakeOptions } = concurrencyProbe(50);
    await setupApp({ fakeOptions });
    const blocking = await call("delegate_task", { cwd: await tempDir(), task: "a" });
    const waited = await call("wait_session", { session_id: blocking.body.session_id });
    expect(waited.body).toMatchObject({ done: true, background: false, status: "completed" });
  });
});
