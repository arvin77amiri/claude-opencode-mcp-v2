import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode, type FakeOpenCodeOptions } from "../helpers/fake-opencode.js";

const T = Date.UTC(2026, 9, 24, 12, 0, 0);

let fake: FakeOpenCode | undefined;
let client: Client | undefined;
let server: McpServer | undefined;
let manager: OpenCodeManager | undefined;
const tempDirs: string[] = [];

async function setup(options: { fake?: FakeOpenCodeOptions; connect?: boolean } = {}) {
  fake = new FakeOpenCode(options.fake);
  const baseUrl = await fake.listen();
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-sessions-"));
  tempDirs.push(stateDir);
  const config = BridgeConfigSchema.parse({
    opencode: options.connect === false ? { autoStart: false } : { url: baseUrl, autoStart: false },
    worktrees: { enabled: false },
  });
  const logger = createLogger({ level: "silent" });
  manager = new OpenCodeManager({ logger });
  server = createMcpServer({
    logger,
    manager,
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

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: CallResult): string {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  return first && first.type === "text" ? first.text : "";
}

function parse(result: CallResult): any {
  return JSON.parse(textOf(result));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  if (!client) throw new Error("not set up");
  return client.callTool({ name, arguments: args });
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await manager?.stopAll().catch(() => undefined);
  await fake?.close().catch(() => undefined);
  client = server = manager = undefined;
  fake = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

const PROJECTS = [
  { id: "prj_demo", canonical: "C:\\work\\demo-app", updated: T },
  { id: "prj_site", canonical: "C:\\work\\site", name: "Marketing Site", updated: T },
  { id: "prj_demo2", canonical: "D:\\other\\Demo-App" },
];

function seedDemo(opencode: FakeOpenCode): void {
  opencode.seedSession({
    id: "ses_a",
    projectID: "prj_demo",
    title: "Fix flaky deploy",
    updated: T + 3_000,
    outcome: "failed",
    messages: [
      { id: "msg_a1", type: "user", text: "the deploy fails on step 3", time: { created: 1 } },
      {
        id: "msg_a2",
        type: "assistant",
        time: { created: 2 },
        content: [{ type: "text", text: "Step 3 times out; retry with backoff." }],
        finish: "error",
        error: { type: "ProviderError", status: 429, message: "Free usage limit reached" },
      },
      { id: "msg_a3", type: "idle", outcome: "failed", time: { created: 3 } },
    ],
  });
  opencode.seedSession({
    id: "ses_b",
    projectID: "prj_demo",
    title: "Add search",
    updated: T + 2_000,
    outcome: "succeeded",
    messages: [
      {
        id: "msg_b1",
        type: "user",
        text: "implement search for the catalog",
        time: { created: 1 },
      },
      {
        id: "msg_b2",
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "REASONING-ONLY-MARKER" },
          {
            type: "tool",
            id: "t1",
            name: "write",
            state: {
              status: "completed",
              input: { path: "src/search.ts", content: "const FILE-CONTENT-MARKER = 1;" },
              content: [{ type: "text", text: "TOOL-OUTPUT-MARKER" }],
            },
          },
          { type: "text", text: "Added fuzzy search with zebra scoring in src/search.ts." },
        ],
        finish: "stop",
      },
    ],
  });
  opencode.seedSession({
    id: "ses_c",
    projectID: "prj_demo",
    title: "Refactor config loader",
    updated: T + 1_000,
    messages: [
      { id: "msg_c1", type: "user", text: "tidy the config loader", time: { created: 1 } },
    ],
  });
  opencode.seedSession({
    id: "ses_child",
    projectID: "prj_demo",
    title: "sub-agent run",
    updated: T + 4_000,
    parentID: "ses_a",
    messages: [
      { id: "msg_k1", type: "user", text: "zebra in a child session", time: { created: 1 } },
    ],
  });
  opencode.seedSession({
    id: "ses_s1",
    projectID: "prj_site",
    title: "Landing page",
    updated: T + 500,
    messages: [],
  });
}

describe("list_projects", () => {
  it("lists projects with name fallback, counts and last activity, newest first", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const result = await call("list_projects");
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    // The empty project prj_demo2 is hidden; the sub-agent child session is not counted.
    expect(data.projects.map((row: { id: string }) => row.id)).toEqual(["prj_demo", "prj_site"]);
    expect(data.projects[0]).toEqual({
      id: "prj_demo",
      name: "demo-app",
      path: "C:\\work\\demo-app",
      session_count: 3,
      last_activity: new Date(T + 4_000).toISOString(),
    });
    expect(data.projects[1]).toMatchObject({ name: "Marketing Site", session_count: 1 });
    expect(data.hidden_empty).toBe(1);
    expect(data.partial).toBeUndefined();
  });

  it("answers with compact text only", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const result = await call("list_projects");
    expect(textOf(result)).not.toContain("\n");
    expect(result.structuredContent).toBeUndefined();
  });

  it("uses GET requests only and never the v1 routes", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    await call("list_projects");
    await call("find_sessions", { project: "prj_demo", query: "zebra" });
    expect(fake!.requests.length).toBeGreaterThan(0);
    expect(fake!.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(fake!.legacyCalls).toBe(0);
  });

  it("fails clearly, without starting OpenCode, when no server is connected", async () => {
    await setup({ fake: { projects: PROJECTS }, connect: false });
    const result = await call("list_projects");
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(manager!.getStatus()).toEqual([]);
    expect(fake!.requests).toEqual([]);
  });
});

describe("find_sessions", () => {
  it("returns the most recent root sessions without a query", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const data = parse(await call("find_sessions", { project: "prj_demo", limit: 2 }));
    expect(data.project).toEqual({ id: "prj_demo", name: "demo-app" });
    expect(data.partial).toBe(false);
    expect(data.sessions).toEqual([
      {
        session_id: "ses_a",
        title: "Fix flaky deploy",
        updated: new Date(T + 3_000).toISOString(),
        outcome: "failed",
      },
      {
        session_id: "ses_b",
        title: "Add search",
        updated: new Date(T + 2_000).toISOString(),
        outcome: "succeeded",
      },
    ]);
  });

  it("accepts an id, a path or a name", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    for (const project of [
      "prj_demo",
      "C:\\work\\demo-app",
      "c:/work/demo-app/src",
      "Marketing Site",
    ]) {
      const data = parse(await call("find_sessions", { project }));
      expect(data.sessions.length).toBeGreaterThan(0);
    }
    const site = parse(await call("find_sessions", { project: "marketing site" }));
    expect(site.sessions.map((hit: { session_id: string }) => hit.session_id)).toEqual(["ses_s1"]);
  });

  it("returns candidates for an ambiguous name instead of guessing", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const result = await call("find_sessions", { project: "DEMO-APP" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.status).toBe("ambiguous");
    // Counts and activity tell look-alike projects apart.
    expect(data.candidates).toMatchObject([
      { id: "prj_demo", name: "demo-app", path: "C:\\work\\demo-app", session_count: 3 },
      { id: "prj_demo2", name: "Demo-App", path: "D:\\other\\Demo-App", session_count: 0 },
    ]);
    expect(data.candidates[0].last_activity).toBe(new Date(T + 4_000).toISOString());
    expect(data.sessions).toBeUndefined();
  });

  it("reports an unknown project as an invalid argument", async () => {
    await setup({ fake: { projects: PROJECTS } });
    const result = await call("find_sessions", { project: "nope" });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("INVALID_ARGUMENT");
  });

  it("finds a word that only appears in message bodies", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const data = parse(await call("find_sessions", { project: "prj_demo", query: "zebra" }));
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({
      session_id: "ses_b",
      match: "content",
      message_ids: ["msg_b2"],
    });
    expect(data.sessions[0].snippet).toContain("zebra scoring");
    expect(data.sessions[0].snippet.length).toBeLessThanOrEqual(200);
    expect(data.scanned).toBe(3);
    expect(data.partial).toBe(false);
  });

  it("never searches reasoning, tool output, tool file content or child sessions", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    for (const query of ["REASONING-ONLY-MARKER", "TOOL-OUTPUT-MARKER", "FILE-CONTENT-MARKER"]) {
      const data = parse(await call("find_sessions", { project: "prj_demo", query }));
      expect(data.sessions).toEqual([]);
    }
    // "zebra" also appears in a sub-agent child session, which is not listed or scanned.
    const data = parse(await call("find_sessions", { project: "prj_demo", query: "zebra" }));
    expect(data.sessions.map((hit: { session_id: string }) => hit.session_id)).toEqual(["ses_b"]);
  });

  it("matches tool paths and error text", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const byPath = parse(
      await call("find_sessions", { project: "prj_demo", query: "src/search.ts" }),
    );
    expect(byPath.sessions[0]).toMatchObject({ session_id: "ses_b", match: "content" });
    const byError = parse(
      await call("find_sessions", { project: "prj_demo", query: "usage limit reached" }),
    );
    expect(byError.sessions[0]).toMatchObject({ session_id: "ses_a", match: "content" });
  });

  it("puts title matches first", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const data = parse(await call("find_sessions", { project: "prj_demo", query: "search" }));
    expect(data.sessions[0]).toMatchObject({
      session_id: "ses_b",
      match: "title",
      title: "Add search",
    });
  });

  it("keeps the answer under 4000 characters even with many long hits", async () => {
    await setup({ fake: { projects: [{ id: "prj_big", canonical: "C:\\work\\big" }] } });
    for (let index = 1; index <= 40; index += 1) {
      fake!.seedSession({
        id: `ses_big_${index}`,
        projectID: "prj_big",
        title: `A long descriptive title for the large session number ${index} of the project`,
        updated: T + index,
        outcome: "succeeded",
        messages: [
          {
            id: `msg_big_${index}`,
            type: "user",
            text: `${"filler ".repeat(60)}commonword ${"padding ".repeat(60)}`,
            time: { created: 1 },
          },
        ],
      });
    }
    const result = await call("find_sessions", {
      project: "prj_big",
      query: "commonword",
      limit: 25,
      scan: 40,
    });
    expect(textOf(result).length).toBeLessThanOrEqual(4_000);
    const data = parse(result);
    expect(data.truncated).toBe(true);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.sessions.length + (data.omitted ?? 0)).toBe(25);
  });
});

const TWINS = [
  { id: "prj_t1", canonical: "C:\\work\\paper", updated: T },
  { id: "prj_t2", canonical: "c:/work/paper/", name: "Paper", updated: T },
  { id: "prj_other", canonical: "D:\\elsewhere\\Paper" },
];

function seedTwins(opencode: FakeOpenCode): void {
  opencode.seedSession({
    id: "ses_t1",
    projectID: "prj_t1",
    title: "Intro draft",
    updated: T + 1_000,
    messages: [{ id: "msg_t1", type: "user", text: "write the intro", time: { created: 1 } }],
  });
  opencode.seedSession({
    id: "ses_t2",
    projectID: "prj_t2",
    title: "Methods draft",
    updated: T + 3_000,
    messages: [{ id: "msg_t2", type: "user", text: "write the methods", time: { created: 1 } }],
  });
  opencode.seedSession({
    id: "ses_t3",
    projectID: "prj_t1",
    title: "Figures",
    updated: T + 2_000,
    messages: [{ id: "msg_t3", type: "user", text: "plot the zebra data", time: { created: 1 } }],
  });
}

describe("twin projects", () => {
  it("merges the sessions of twins into one answer and reports every id", async () => {
    // "paper" matches prj_t1 and prj_t2 (same folder) but also prj_other (another folder).
    await setup({ fake: { projects: TWINS.slice(0, 2) } });
    seedTwins(fake!);
    const data = parse(await call("find_sessions", { project: "paper" }));
    expect(data.status).toBeUndefined();
    expect(data.project).toEqual({ id: "prj_t1", ids: ["prj_t1", "prj_t2"], name: "paper" });
    expect(data.sessions.map((hit: { session_id: string }) => hit.session_id)).toEqual([
      "ses_t2",
      "ses_t3",
      "ses_t1",
    ]);
  });

  it("searches content in every twin and finds a session of the other id", async () => {
    await setup({ fake: { projects: TWINS.slice(0, 2) } });
    seedTwins(fake!);
    const byId = parse(await call("find_sessions", { project: "prj_t2", query: "zebra" }));
    expect(byId.project.ids).toEqual(["prj_t2", "prj_t1"]);
    expect(byId.sessions).toHaveLength(1);
    expect(byId.sessions[0]).toMatchObject({ session_id: "ses_t3", match: "content" });
  });

  it("keeps the ambiguous answer when the candidates are different folders", async () => {
    await setup({ fake: { projects: TWINS } });
    seedTwins(fake!);
    const data = parse(await call("find_sessions", { project: "paper" }));
    expect(data.status).toBe("ambiguous");
    // The twins are one candidate, the other folder another.
    expect(data.candidates).toHaveLength(2);
    expect(data.candidates[0]).toMatchObject({
      id: "prj_t2",
      ids: ["prj_t2", "prj_t1"],
      session_count: 3,
    });
    expect(data.candidates[1]).toMatchObject({ id: "prj_other" });
  });

  it("lists twins as one project", async () => {
    await setup({ fake: { projects: TWINS } });
    seedTwins(fake!);
    const data = parse(await call("list_projects"));
    expect(data.projects).toEqual([
      {
        id: "prj_t2",
        ids: ["prj_t2", "prj_t1"],
        name: "Paper",
        path: "c:/work/paper/",
        session_count: 3,
        last_activity: new Date(T + 3_000).toISOString(),
      },
    ]);
    // prj_other has no sessions.
    expect(data.hidden_empty).toBe(1);
  });
});

describe("session_digest", () => {
  it("catches the real error of a failed session and stays small", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const result = await call("session_digest", { session_id: "ses_a" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result).length).toBeLessThanOrEqual(1_500);
    expect(textOf(result)).not.toContain("\n");
    const digest = parse(result);
    expect(digest).toMatchObject({
      title: "Fix flaky deploy",
      goal: "the deploy fails on step 3",
      last_request: "the deploy fails on step 3",
      files_changed: [],
      errors: [
        {
          msg_id: "msg_a2",
          type: "ProviderError",
          status: 429,
          message: "Free usage limit reached",
        },
      ],
      final_state: { outcome: "failed", finish: "error" },
      counts: { messages: 3, user: 1, assistant: 1 },
      fingerprint: "msg_a3@3:failed",
    });
  });

  it("lists changed files from tool inputs and counts tools, without any content", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const result = await call("session_digest", { session_id: "ses_b" });
    const digest = parse(result);
    expect(digest.files_changed).toEqual(["src/search.ts"]);
    expect(digest.tools_used).toEqual({ write: 1 });
    expect(digest.final_state.outcome).toBe("succeeded");
    const text = textOf(result);
    for (const marker of ["REASONING-ONLY-MARKER", "FILE-CONTENT-MARKER", "TOOL-OUTPUT-MARKER"]) {
      expect(text).not.toContain(marker);
    }
  });

  it("reads with GET only, never sends order with a cursor and never starts OpenCode", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    await call("session_digest", { session_id: "ses_a" });
    expect(fake!.requests.length).toBeGreaterThan(0);
    expect(fake!.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(
      fake!.requests.filter(
        (request) => /[?&]order=/.test(request.path) && /[?&]cursor=/.test(request.path),
      ),
    ).toEqual([]);
    expect(fake!.legacyCalls).toBe(0);
  });

  it("reports an unknown or malformed session id clearly", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const unknown = await call("session_digest", { session_id: "ses_nope" });
    expect(unknown.isError).toBe(true);
    expect(parse(unknown).error.code).toBe("OPENCODE_SESSION_NOT_FOUND");
    const malformed = await call("session_digest", { session_id: "abc" });
    expect(malformed.isError).toBe(true);
    expect(parse(malformed).error.code).toBe("INVALID_ARGUMENT");
  });

  it("fails clearly, without starting OpenCode, when no server is connected", async () => {
    await setup({ fake: { projects: PROJECTS }, connect: false });
    const result = await call("session_digest", { session_id: "ses_a" });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(manager!.getStatus()).toEqual([]);
    expect(fake!.requests).toEqual([]);
  });
});

describe("read_messages", () => {
  it("reads the messages that find_sessions pointed at", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const found = parse(await call("find_sessions", { project: "prj_demo", query: "zebra" }));
    const hit = found.sessions[0];
    const result = await call("read_messages", {
      session_id: hit.session_id,
      message_ids: hit.message_ids,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      id: "msg_b2",
      type: "assistant",
      finish: "stop",
      tools: [{ name: "write", status: "completed", input_summary: "src/search.ts" }],
      truncated: false,
    });
    expect(data.messages[0].text).toContain("zebra scoring");
    const text = textOf(result);
    for (const marker of ["REASONING-ONLY-MARKER", "FILE-CONTENT-MARKER", "TOOL-OUTPUT-MARKER"]) {
      expect(text).not.toContain(marker);
    }
  });

  it("shows neighbours with around and keeps to max_chars", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const data = parse(
      await call("read_messages", { session_id: "ses_a", around: "msg_a2", before: 1, after: 1 }),
    );
    expect(data.messages.map((message: { id: string }) => message.id)).toEqual([
      "msg_a1",
      "msg_a2",
      "msg_a3",
    ]);
    expect(data.messages[1].error).toEqual({
      type: "ProviderError",
      status: 429,
      message: "Free usage limit reached",
    });
    const tight = await call("read_messages", {
      session_id: "ses_a",
      around: "msg_a2",
      before: 1,
      after: 1,
      max_chars: 500,
    });
    expect(textOf(tight).length).toBeLessThanOrEqual(500);
  });

  it("needs exactly one of message_ids and around", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    for (const args of [
      { session_id: "ses_a" },
      { session_id: "ses_a", message_ids: ["msg_a1"], around: "msg_a2" },
    ]) {
      const result = await call("read_messages", args);
      expect(result.isError).toBe(true);
      expect(parse(result).error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("reports an unknown session and unknown message ids", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    const unknown = await call("read_messages", { session_id: "ses_nope", message_ids: ["msg_x"] });
    expect(unknown.isError).toBe(true);
    expect(parse(unknown).error.code).toBe("OPENCODE_SESSION_NOT_FOUND");
    const missing = parse(
      await call("read_messages", { session_id: "ses_a", message_ids: ["msg_a1", "msg_zzz"] }),
    );
    expect(missing.missing_ids).toEqual(["msg_zzz"]);
    expect(missing.messages).toHaveLength(1);
  });

  it("uses GET requests only", async () => {
    await setup({ fake: { projects: PROJECTS } });
    seedDemo(fake!);
    await call("read_messages", { session_id: "ses_a", around: "msg_a2" });
    await call("read_messages", { session_id: "ses_a", message_ids: ["msg_a1"] });
    expect(fake!.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(fake!.legacyCalls).toBe(0);
  });
});
