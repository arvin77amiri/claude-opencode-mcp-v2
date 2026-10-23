import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema, type ResolvedConfig } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode, type FakeOpenCodeOptions } from "../helpers/fake-opencode.js";

let fake: FakeOpenCode;
let client: Client;
let server: McpServer;
let manager: OpenCodeManager;
let stateDir: string;
const tempDirs: string[] = [];

async function tempDir(prefix = "co-int-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupApp(options: {
  fakeOptions?: FakeOpenCodeOptions;
  configOverrides?: Record<string, unknown>;
}): Promise<{ config: ResolvedConfig }> {
  fake = new FakeOpenCode(options.fakeOptions);
  const baseUrl = await fake.listen();
  stateDir = await tempDir();
  const config = BridgeConfigSchema.parse({
    opencode: { url: baseUrl, autoStart: false },
    // These suites cover the shared-workspace mode; worktree isolation has its own suite.
    worktrees: { enabled: false },
    ...(options.configOverrides ?? {}),
  });
  const logger = createLogger({ level: "silent" });
  const registry = new SessionRegistry(path.join(stateDir, "sessions.json"), logger);
  manager = new OpenCodeManager({ logger });
  server = createMcpServer({
    logger,
    manager,
    registry,
    globalConfig: config,
    env: process.env,
    stateDir,
    loadProjectConfig: async () => ({ config, sources: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { config };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  if (first && first.type === "text") return first.text;
  return "";
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse(textOf(result));
}

beforeEach(() => {
  // each test sets up its own app
});

afterEach(async () => {
  try {
    await client?.close();
  } catch {
    // ignore
  }
  try {
    await server?.close();
  } catch {
    // ignore
  }
  try {
    await fake?.close();
  } catch {
    // ignore
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP tool surface", () => {
  it("registers the PRD tools plus wait_session", async () => {
    await setupApp({});
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "abort_session",
      "create_session",
      "delegate_task",
      "discard_task",
      "get_diff",
      "get_session",
      "list_agents",
      "merge_task",
      "send_message",
      "wait_session",
    ]);
  });

  it("lists agents with capabilities", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({ name: "list_agents", arguments: { cwd: workspace } }),
    );
    expect(result.default_agent).toBe("researcher");
    const names = result.agents.map((agent: { name: string }) => agent.name);
    expect(names).toContain("coder");
    const coder = result.agents.find((agent: { name: string }) => agent.name === "coder");
    expect(coder.can_edit).toBe(true);
    const researcher = result.agents.find((agent: { name: string }) => agent.name === "researcher");
    expect(researcher.read_only).toBe(true);
  });
});

describe("delegate_task", () => {
  it("runs a task end-to-end and returns a structured result", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: {
          cwd: workspace,
          agent: "reviewer",
          task: "Review the auth module",
          paths: ["src/auth"],
        },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.session_id).toMatch(/^ses_/);
    expect(result.agent).toBe("reviewer");
    expect(result.model).toBe("deepseek/deepseek-v4-pro");
    expect(result.summary).toContain("FAKE DONE");
    expect(result.cwd).toBe(await fs.promises.realpath(workspace));

    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]?.agent).toBe("reviewer");
    expect(fake.prompts[0]?.text).toContain(workspace);
    expect(fake.prompts[0]?.text).toContain("Review the auth module");
    expect(fake.legacyCalls).toBe(0);
  });

  it("waits for the final message after tool-call steps", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "FINAL ANSWER", toolStep: true }) },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "coder", task: "do work" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("FINAL ANSWER");
  });

  it("parses findings from the agent output", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({
          text: [
            "## Summary",
            "Found issues.",
            "",
            "## Findings",
            "- [severity: high] Missing CSRF protection (src/web/form.ts:12) — forms are unprotected",
            "",
            "## Verdict",
            "Request changes.",
          ].join("\n"),
        }),
      },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "reviewer", task: "Review forms" },
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].file).toBe("src/web/form.ts");
  });

  it("rejects unknown agents with AGENT_NOT_FOUND", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "does-not-exist", task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("rejects bad workspace with WORKSPACE_NOT_FOUND", async () => {
    await setupApp({});
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: path.join(os.tmpdir(), "missing-workspace-xyz"), task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("rejects path hints that escape the workspace", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x", paths: ["../../etc"] },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("INVALID_PATH");
  });

  it("grants edits to a read-only agent when the orchestrator asks", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "Do research and write notes", allow_edits: true },
    });
    expect(fake.prompts[0]?.agent).toBe("researcher__edit");
  });

  it("grants edits and shell together with both overrides", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: {
        cwd: workspace,
        agent: "researcher",
        task: "Implement and test",
        allow_edits: true,
        allow_bash: true,
      },
    });
    expect(fake.prompts[0]?.agent).toBe("researcher__rw");
  });

  it("revokes edits from a coding agent when the orchestrator asks", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "coder", task: "Edit", allow_edits: false },
    });
    // coder defaults to edits+shell; revoking edits keeps shell.
    expect(fake.prompts[0]?.agent).toBe("coder__bash");
  });

  it("keeps the default agent name when no override is requested", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    expect(fake.prompts[0]?.agent).toBe("researcher");
  });

  it("persists orchestrator permissions across send_message", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: {
          cwd: workspace,
          agent: "researcher",
          allow_edits: true,
          allow_bash: true,
        },
      }),
    );
    expect(created.can_edit).toBe(true);
    expect(created.can_run_bash).toBe(true);

    await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "First" },
    });
    await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "Second", allow_edits: false },
    });

    expect(fake.prompts[0]?.agent).toBe("researcher__rw");
    // Revoking edits keeps shell at the variant level.
    expect(fake.prompts[1]?.agent).toBe("researcher__bash");

    const session = parse(
      await client.callTool({ name: "get_session", arguments: { session_id: created.session_id } }),
    );
    expect(session.can_edit).toBe(false);
    expect(session.can_run_bash).toBe(true);
  });

  it("reports timeouts as AGENT_TIMEOUT without hanging", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "late", delayMs: 1000 }) },
    });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "slow work", timeout: 300 },
    });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.status).toBe("timeout");
    expect(body.error.code).toBe("AGENT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("surfaces provider errors from OpenCode", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({
          text: "",
          error: {
            name: "ProviderAuthError",
            data: { providerID: "deepseek", message: "bad key" },
          },
        }),
      },
    });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    const body = parse(result);
    expect(result.isError).toBe(true);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("OPENCODE_ERROR");
    expect(body.error.message).toContain("deepseek");
  });

  it("falls back to a prompt preamble when the server does not know the agent", async () => {
    await setupApp({
      fakeOptions: { agents: [{ name: "build", mode: "primary" }] },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, task: "Inspect the layout" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(fake.prompts[0]?.agent).toBeUndefined();
    expect(fake.prompts[0]?.text).toContain("Inspect the layout");
    // The agent's system prompt travels with the user message.
    expect(fake.prompts[0]?.text).toContain("---");
  });

  it("retries the agent lookup during the OpenCode config warm-up instead of using the preamble", async () => {
    // Regression: right after startup OpenCode 2 answers 404 for agents from
    // OPENCODE_CONFIG_CONTENT; the bridge used to take that for "unknown agent"
    // and ran the task as `build` with a prompt preamble.
    await setupApp({ fakeOptions: { agentWarmupMs: 700 } });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "reviewer", task: "Inspect the layout" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(fake.warmupMisses).toBeGreaterThan(0);
    expect(fake.prompts[0]?.agent).toBe("reviewer");
    expect(fake.prompts[0]?.text).not.toContain("---");
  });

  it("rejects models missing from the OpenCode catalog", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x", model: "deepseek/nope" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("MODEL_NOT_AVAILABLE");
    expect(fake.sessions.size).toBe(0);
  });

  it("creates the session with location, model and a policy-derived ruleset", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "researcher", task: "x" },
    });
    const session = [...fake.sessions.values()][0]!;
    expect(session.directory).toBe(await fs.promises.realpath(workspace));
    expect(session.model).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro" });
    expect(session.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(session.permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
    expect(session.permissions.some((rule) => rule.effect === "ask")).toBe(false);
  });

  it("updates the session ruleset when send_message changes permissions", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "researcher" },
      }),
    );
    await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "write it", allow_edits: true },
    });
    expect(fake.prompts[0]?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(fake.prompts[0]?.agent).toBe("researcher__edit");
  });

  it("completes through polling when the event stream stays silent", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "polled result", silent: true }) },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, task: "x" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("polled result");
  });

  it("rejects permission asks raised during a run", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({ text: "ok", delayMs: 2500 }),
      },
    });
    const workspace = await tempDir();
    const pending = client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    // Wait for the session to exist, then raise an ask through the poll path.
    for (let i = 0; i < 50 && fake.sessions.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sessionId = [...fake.sessions.keys()][0]!;
    fake.pendingPermissions.set(sessionId, [
      { id: "per_1", sessionID: sessionId, action: "external_directory", resources: ["/etc/*"] },
    ]);
    expect(parse(await pending).status).toBe("completed");
    expect(fake.permissionReplies).toContainEqual([sessionId, "per_1", "reject"]);
  });

  it("returns OPENCODE_UNAVAILABLE instead of hanging when the server is gone", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const baseUrl = fake.server.address();
    expect(baseUrl).toBeTruthy();
    await fake.close();

    const started = Date.now();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x", timeout: 5000 },
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_UNAVAILABLE");
  });

  it("serves multiple concurrent delegations on one server", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "done", delayMs: 400 }) },
    });
    const workspace = await tempDir();
    const results = await Promise.all([
      client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "researcher", task: "task one" },
      }),
      client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "coder", task: "task two" },
      }),
      client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "reviewer", task: "task three" },
      }),
    ]);
    for (const result of results) {
      expect(parse(result).status).toBe("completed");
    }
    expect(fake.prompts).toHaveLength(3);
    expect(new Set(fake.prompts.map((prompt) => prompt.sessionId)).size).toBe(3);
    expect(manager.getStatus()).toHaveLength(1);
    // Regression guard: no v1 routes (they answer HTML with HTTP 200 on OpenCode 2).
    expect(fake.legacyCalls).toBe(0);
  });

  it("refuses a second editing run on the same workspace with WORKSPACE_BUSY", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "done", delayMs: 800 }) },
    });
    const workspace = await tempDir();
    const first = client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "coder", task: "edit one" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [busy, reader] = await Promise.all([
      client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "coder", task: "edit two" },
      }),
      client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "reviewer", task: "read along" },
      }),
    ]);
    expect(busy.isError).toBe(true);
    const error = parse(busy).error;
    expect(error.code).toBe("WORKSPACE_BUSY");
    expect(error.retryable).toBe(true);
    expect(parse(reader).status).toBe("completed");
    const firstResult = parse(await first);
    expect(firstResult.status).toBe("completed");
    expect(error.details.busy_session_id).toBe(firstResult.session_id);
    // The refused run never reached OpenCode.
    expect(fake.prompts.some((prompt) => prompt.text.includes("edit two"))).toBe(false);

    // The workspace is free again once the first run ends.
    const again = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "coder", task: "edit three" },
      }),
    );
    expect(again.status).toBe("completed");
  });

  it("guards send_message editing runs too", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "done", delayMs: 800 }) },
    });
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "coder" },
      }),
    );
    const running = client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "coder", task: "edit one" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "edit two" },
    });
    expect(parse(busy).error.code).toBe("WORKSPACE_BUSY");
    expect(parse(await running).status).toBe("completed");
  });

  it("reports the cost and tokens of a run and accumulates them on the session", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({
          text: "done",
          toolStep: true,
          usage: {
            cost: 0.25,
            tokens: { input: 1000, output: 100, reasoning: 10, cache: { read: 500, write: 0 } },
          },
        }),
      },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "researcher", task: "map it" },
      }),
    );
    // Two assistant messages: the tool step and the final answer.
    expect(result.usage).toEqual({
      cost: 0.5,
      input_tokens: 2000,
      output_tokens: 200,
      reasoning_tokens: 20,
      cache_read_tokens: 1000,
      cache_write_tokens: 0,
    });

    const followUp = parse(
      await client.callTool({
        name: "send_message",
        arguments: { session_id: result.session_id, message: "more" },
      }),
    );
    // Only this run's messages, not the earlier ones.
    expect(followUp.usage.input_tokens).toBe(2000);

    const session = parse(
      await client.callTool({ name: "get_session", arguments: { session_id: result.session_id } }),
    );
    expect(session.usage.input_tokens).toBe(4000);
    expect(session.usage.cost).toBe(1);
  });

  it("omits usage when OpenCode reports none", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, task: "x" },
      }),
    );
    expect(result.usage).toBeUndefined();
    expect(result.changed_files).toEqual([]);
  });

  it("rejects oversized inputs instead of forwarding them", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const tooManyPaths = Array.from({ length: 201 }, (_, index) => `src/p${index}`);
    let rejected = false;
    let isError = false;
    try {
      const result = await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, task: "x", paths: tooManyPaths },
      });
      isError = Boolean(result.isError);
    } catch {
      rejected = true;
    }
    expect(rejected || isError).toBe(true);
    expect(fake.prompts).toHaveLength(0);
  });

  it("refuses to delegate when OpenCode reports a different directory", async () => {
    await setupApp({ fakeOptions: { reportedDirectory: "/somewhere/else" } });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("WORKSPACE_MISMATCH");
  });
});

describe("sessions", () => {
  it("keeps context across create_session + send_message", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "researcher", title: "auth investigation" },
      }),
    );
    expect(created.session_id).toMatch(/^ses_/);

    await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "First: inspect src/auth" },
    });
    await client.callTool({
      name: "send_message",
      arguments: {
        session_id: created.session_id,
        message: "Second: now inspect the database layer",
      },
    });

    expect(fake.prompts).toHaveLength(2);
    expect(new Set(fake.prompts.map((prompt) => prompt.sessionId)).size).toBe(1);
    expect(fake.prompts[1]?.text).toContain("now inspect the database layer");
    expect(fake.prompts[1]?.text).toContain("Constraints:");

    const session = parse(
      await client.callTool({ name: "get_session", arguments: { session_id: created.session_id } }),
    );
    expect(session.status).toBe("completed");
    expect(session.last_summary).toContain("FAKE DONE");
    expect(session.opencode.last_activity_at).toEqual(expect.any(String));
    expect(session.opencode.idle_ms).toBeGreaterThanOrEqual(0);

    const aborted = parse(
      await client.callTool({
        name: "abort_session",
        arguments: { session_id: created.session_id },
      }),
    );
    expect(aborted.aborted).toBe(true);
  });

  it("returns OPENCODE_SESSION_NOT_FOUND for unknown sessions", async () => {
    await setupApp({});
    const result = await client.callTool({
      name: "get_session",
      arguments: { session_id: "ses_missing" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_SESSION_NOT_FOUND");
  });
});

describe("get_diff", () => {
  it("returns the OpenCode session diff", async () => {
    await setupApp({
      fakeOptions: {
        diff: [
          {
            file: "app.ts",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
          {
            file: "new-file.ts",
            patch: "@@ +1 @@\n+x\n",
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ],
      },
    });
    const workspace = await tempDir("co-diff-");
    const delegated = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "coder", task: "Bump a" },
      }),
    );
    expect(delegated.status).toBe("completed");
    expect(delegated.files_changed).toBe(2);
    expect(delegated.changed_files).toEqual([
      { file: "app.ts", additions: 1, deletions: 1, status: "modified" },
      { file: "new-file.ts", additions: 1, deletions: 0, status: "added" },
    ]);

    const diff = parse(
      await client.callTool({ name: "get_diff", arguments: { session_id: delegated.session_id } }),
    );
    expect(diff.source).toBe("opencode");
    expect(diff.files.map((entry: { file: string }) => entry.file)).toEqual([
      "app.ts",
      "new-file.ts",
    ]);
    expect(diff.files[1].status).toBe("added");
    expect(diff.diff).toContain("+b");
  });

  it("reports DIFF_UNAVAILABLE when OpenCode has no changes for the session", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "coder" },
      }),
    );
    const result = await client.callTool({
      name: "get_diff",
      arguments: { session_id: created.session_id },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("DIFF_UNAVAILABLE");
  });

  it("explains in DIFF_UNAVAILABLE that the workspace is not a git repository", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "coder" },
      }),
    );
    const error = parse(
      await client.callTool({ name: "get_diff", arguments: { session_id: created.session_id } }),
    ).error;
    expect(error.message).toContain("not a git repository");
    expect(error.details.git_repository).toBe(false);
  });

  it("falls back to a git diff against the creation baseline when OpenCode reports nothing", async () => {
    await setupApp({});
    const workspace = await tempDir("co-gitdiff-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: workspace,
      });
    git("init", "-q");
    fs.writeFileSync(path.join(workspace, "a.txt"), "one\n");
    fs.writeFileSync(path.join(workspace, "pre.txt"), "dirty-before\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");

    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "coder" },
      }),
    );
    fs.writeFileSync(path.join(workspace, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(workspace, "b.txt"), "new\n");

    const diff = parse(
      await client.callTool({ name: "get_diff", arguments: { session_id: created.session_id } }),
    );
    expect(diff.source).toBe("git");
    const names = diff.files.map((entry: { file: string }) => entry.file).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
    expect(diff.diff).toContain("+two");
  });
});
