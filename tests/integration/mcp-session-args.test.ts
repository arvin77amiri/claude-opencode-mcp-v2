import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode } from "../helpers/fake-opencode.js";

/**
 * The four read-only history tools called through tools/call, like a real MCP client does:
 * every argument must arrive at the handler intact. Stage 3/4 checked the functions directly and
 * missed an argument that a real client path lost (session_id), so these go over the wire, once
 * in memory and once over stdio against the built bridge.
 */

const T = Date.UTC(2026, 9, 24, 12, 0, 0);
const LONG = "long-answer ".repeat(80).trim();
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function parse(result: CallResult): any {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (first?.type !== "text") throw new Error("no text content in tool result");
  return JSON.parse(first.text);
}

function seed(fake: FakeOpenCode): void {
  fake.seedSession({
    id: "ses_a",
    projectID: "prj_demo",
    title: "Fix flaky deploy",
    updated: T + 3_000,
    outcome: "succeeded",
    messages: [
      { id: "m1", type: "user", text: "the deploy fails on step 3", time: { created: 1 } },
      {
        id: "m2",
        type: "assistant",
        time: { created: 2 },
        content: [{ type: "text", text: LONG }],
        finish: "stop",
      },
      { id: "m3", type: "user", text: "retry with backoff please", time: { created: 3 } },
      {
        id: "m4",
        type: "assistant",
        time: { created: 4 },
        content: [{ type: "text", text: "Done, backoff added." }],
        finish: "stop",
      },
      { id: "m5", type: "user", text: "thanks", time: { created: 5 } },
    ],
  });
  fake.seedSession({
    id: "ses_b",
    projectID: "prj_demo",
    title: "Add search",
    updated: T + 2_000,
    outcome: "succeeded",
    messages: [{ id: "b1", type: "user", text: "implement search", time: { created: 1 } }],
  });
}

const PROJECTS = [{ id: "prj_demo", canonical: "C:\\work\\demo-app", updated: T }];

interface Wire {
  client: Client;
  close: () => Promise<void>;
}

/** Client and bridge in one process (tools/call still goes through the MCP request path). */
async function inMemoryWire(baseUrl: string, tempDirs: string[]): Promise<Wire> {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-args-"));
  tempDirs.push(stateDir);
  const config = BridgeConfigSchema.parse({
    opencode: { url: baseUrl, autoStart: false },
    worktrees: { enabled: false },
  });
  const logger = createLogger({ level: "silent" });
  const manager = new OpenCodeManager({ logger });
  const server = createMcpServer({
    logger,
    manager,
    registry: new SessionRegistry(path.join(stateDir, "sessions.json"), logger),
    globalConfig: config,
    env: process.env,
    stateDir,
    loadProjectConfig: async () => ({ config, sources: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "args-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await manager.stopAll().catch(() => undefined);
    },
  };
}

/** The built bridge as a child process speaking JSON-RPC over stdio, like Claude Desktop runs it. */
async function stdioWire(baseUrl: string, tempDirs: string[]): Promise<Wire> {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-args-stdio-"));
  tempDirs.push(stateDir);
  const configFile = path.join(stateDir, "config.json");
  await fs.promises.writeFile(
    configFile,
    JSON.stringify({
      opencode: { url: baseUrl, autoStart: false, desktop: false },
      worktrees: { enabled: false },
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: {
      ...(process.env as Record<string, string>),
      // An empty global config dir: the machine's own config (e.g. desktop mode) must not apply.
      XDG_CONFIG_HOME: path.join(stateDir, "xdg"),
      CLAUDE_OPENCODE_CONFIG: configFile,
      CLAUDE_OPENCODE_STATE_DIR: stateDir,
      CLAUDE_OPENCODE_LOG: "silent",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "args-test-stdio", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => undefined) };
}

let toClose: Wire | undefined;
let fakeServer: FakeOpenCode | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await toClose?.close();
  await fakeServer?.close().catch(() => undefined);
  toClose = fakeServer = undefined;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      ),
  );
});

async function runAllFour(wire: Wire, fake: FakeOpenCode): Promise<void> {
  const { client } = wire;

  // The advertised schema offers the id under both spellings and requires neither: a client path
  // that drops one must not fail validation before the handler can say what is missing.
  const tools = (await client.listTools()).tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ["session_digest", "read_messages"]) {
    const schema = byName.get(name)?.inputSchema as { properties?: object; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["session", "session_id"]),
    );
    expect(schema.required ?? []).not.toContain("session");
    expect(schema.required ?? []).not.toContain("session_id");
  }
  expect(byName.get("find_sessions")?.inputSchema.required).toEqual(["project"]);

  // list_projects: no arguments.
  const projects = parse(await client.callTool({ name: "list_projects", arguments: {} }));
  expect(projects.projects.map((project: { id: string }) => project.id)).toEqual(["prj_demo"]);

  // find_sessions: project, query, limit and scan all arrive.
  const found = parse(
    await client.callTool({
      name: "find_sessions",
      arguments: { project: "prj_demo", query: "deploy", limit: 1, scan: 5 },
    }),
  );
  expect(found.project.id).toBe("prj_demo");
  expect(found.query).toBe("deploy");
  expect(found.sessions).toHaveLength(1);
  expect(found.sessions[0].session_id).toBe("ses_a");
  const listed = parse(
    await client.callTool({ name: "find_sessions", arguments: { project: "prj_demo", limit: 2 } }),
  );
  expect(listed.sessions.map((session: { session_id: string }) => session.session_id)).toEqual([
    "ses_a",
    "ses_b",
  ]);

  // session_digest: the id under either spelling reaches OpenCode untouched.
  fake.requests.splice(0);
  const bySession = parse(
    await client.callTool({ name: "session_digest", arguments: { session: "ses_a" } }),
  );
  const bySessionId = parse(
    await client.callTool({ name: "session_digest", arguments: { session_id: "ses_a" } }),
  );
  expect(bySession.title).toBe("Fix flaky deploy");
  expect(bySessionId).toEqual(bySession);
  const touched = new Set(
    fake.requests.flatMap((request) => request.path.match(/ses_[A-Za-z0-9]+/g) ?? []),
  );
  expect([...touched]).toEqual(["ses_a"]);

  // read_messages: ids (in the given order), around/before/after, and both size caps.
  const byIds = parse(
    await client.callTool({
      name: "read_messages",
      arguments: { session: "ses_a", message_ids: ["m3", "m1"] },
    }),
  );
  expect(byIds.session_id).toBe("ses_a");
  expect(byIds.messages.map((message: { id: string }) => message.id)).toEqual(["m3", "m1"]);
  const near = parse(
    await client.callTool({
      name: "read_messages",
      arguments: { session_id: "ses_a", around: "m3", before: 1, after: 1 },
    }),
  );
  expect(near.messages.map((message: { id: string }) => message.id)).toEqual(["m2", "m3", "m4"]);
  const capped = parse(
    await client.callTool({
      name: "read_messages",
      arguments: { session: "ses_a", message_ids: ["m2"], per_message_chars: 200 },
    }),
  );
  expect(capped.messages[0].truncated).toBe(true);
  expect(capped.messages[0].text.length).toBeLessThan(LONG.length);
  const full = parse(
    await client.callTool({
      name: "read_messages",
      arguments: { session: "ses_a", message_ids: ["m2"], per_message_chars: 2_000 },
    }),
  );
  expect(full.messages[0].truncated).toBeFalsy();

  // A call that carries no id at all is a clear INVALID_ARGUMENT, not a schema error.
  for (const name of ["session_digest", "read_messages"]) {
    const missing = await client.callTool({
      name,
      arguments: name === "read_messages" ? { message_ids: ["m1"] } : {},
    });
    expect(missing.isError).toBe(true);
    expect(parse(missing).error.code).toBe("INVALID_ARGUMENT");
    expect(parse(missing).error.message).toContain("`session`");
  }

  // Read-only, and never the v1 routes.
  expect(fake.requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(fake.legacyCalls).toBe(0);
}

describe("history tools through tools/call", () => {
  it("deliver every argument intact (in-memory MCP client)", async () => {
    const fake = new FakeOpenCode({ projects: PROJECTS });
    fakeServer = fake;
    const baseUrl = await fake.listen();
    seed(fake);
    toClose = await inMemoryWire(baseUrl, tempDirs);
    await runAllFour(toClose, fake);
  });

  it.skipIf(!fs.existsSync(DIST))(
    "deliver every argument intact (built bridge over stdio)",
    async () => {
      const fake = new FakeOpenCode({ projects: PROJECTS });
      fakeServer = fake;
      const baseUrl = await fake.listen();
      seed(fake);
      toClose = await stdioWire(baseUrl, tempDirs);
      await runAllFour(toClose, fake);
    },
    60_000,
  );
});
