import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConfigSchema, type ResolvedConfig } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";

const ENABLED = process.env.CLAUDE_OPENCODE_E2E === "1";
const E2E_MODEL = process.env.CLAUDE_OPENCODE_E2E_MODEL ?? null;
// The OpenCode server may still hold its cwd for a moment on Windows (EBUSY).
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
const TIMEOUT = 580_000;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeWorkspace(
  name: string,
  markerFile: string,
  markerContent: string,
): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `co-e2e-${name}-`));
  const real = await fs.promises.realpath(dir);
  git(real, ["init", "-q"]);
  await fs.promises.writeFile(path.join(real, markerFile), `${markerContent}\n`);
  await fs.promises.writeFile(
    path.join(real, "package.json"),
    JSON.stringify({ name, private: true, version: "0.0.0" }, null, 2),
  );
  git(real, ["add", "-A"]);
  git(real, ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-qm", "init"]);
  return real;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content;
  if (Array.isArray(content) && content[0]?.type === "text") return JSON.parse(content[0].text);
  throw new Error("no text content in tool result");
}

/**
 * The MCP client defaults to a 60s request timeout. Real agent runs take
 * longer, so tests use progress-resetting long timeouts (Claude Code does the
 * same through its per-server `timeout` setting).
 */
function patchClientTimeout(target: Client, timeout: number): void {
  const original = target.callTool.bind(target);
  target.callTool = ((params: unknown, schema?: unknown, options?: Record<string, unknown>) =>
    original(
      params as never,
      schema as never,
      {
        timeout,
        maxTotalTimeout: timeout,
        resetTimeoutOnProgress: true,
        ...(options ?? {}),
      } as never,
    )) as Client["callTool"];
}

describe.skipIf(!ENABLED)("E2E with real OpenCode 2.x", () => {
  let repoA: string;
  let repoB: string;
  let client: Client;
  let server: McpServer;
  let manager: OpenCodeManager;
  let config: ResolvedConfig;
  const stateDirs: string[] = [];

  beforeAll(async () => {
    repoA = await makeWorkspace("a", "ONLY_A.txt", "content A: alpha-42");
    repoB = await makeWorkspace("b", "ONLY_B.txt", "content B: beta-99");
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-e2e-state-"));
    stateDirs.push(stateDir);

    config = BridgeConfigSchema.parse({
      // No provider or model is assumed in v2: unless CLAUDE_OPENCODE_E2E_MODEL (`provider/model`) is set,
      // OpenCode's own default model is used (free hosted models rotate, so none is hard-coded).
      defaults: { agent: "researcher", model: E2E_MODEL },
      timeouts: { execution: TIMEOUT },
    });
    const logger = createLogger({ level: "silent" });
    manager = new OpenCodeManager({ logger });
    const registry = new SessionRegistry(path.join(stateDir, "sessions.json"), logger);
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
    client = new Client({ name: "e2e", version: "0.0.0" });
    patchClientTimeout(client, TIMEOUT);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {}
    try {
      await server?.close();
    } catch {}
    await manager?.stopAll();
    for (const dir of stateDirs) await fs.promises.rm(dir, RM_OPTIONS);
    for (const dir of [repoA, repoB]) {
      if (dir) await fs.promises.rm(dir, RM_OPTIONS);
    }
  });

  it(
    "cold start: first delegation runs on the real agent with the generated server password",
    async () => {
      // Regression for the two startup bugs found against OpenCode 2.x:
      //  1. `opencode serve` without OPENCODE_SERVER_PASSWORD answers 401 to the bridge
      //     unless the bridge generates and passes its own password.
      //  2. Right after "listening", GET /api/agent/{id} is 404 for agents defined through
      //     OPENCODE_CONFIG_CONTENT (~1 s warm-up); the bridge used to fall back to `build`
      //     plus a prompt preamble instead of the requested agent.
      // This is the very first call on a freshly spawned server, so it hits both windows.
      expect(manager.existingClient()).toBeNull();
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: { cwd: repoA, agent: "researcher", task: "Reply with exactly: hi" },
        }),
      );
      expect(result.status).toBe("completed");

      const live = manager.existingClient();
      expect(live).not.toBeNull();
      const page = await live!.messages(result.session_id, { order: "asc", limit: 20 });
      const assistants = page.data.filter((message) => message.type === "assistant");
      expect(assistants.length).toBeGreaterThan(0);
      for (const message of assistants) {
        expect((message as { agent?: string }).agent).toBe("researcher");
      }
      const preamble = page.data.some(
        (message) => message.type === "user" && String(message.text ?? "").includes("---"),
      );
      expect(preamble).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "Phase 1/2: researcher sees the right repository and never confuses workspaces",
    async () => {
      const a = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "List the files in the project root and report the exact contents of the .txt file you find.",
          },
        }),
      );
      expect(a.status).toBe("completed");
      expect(a.summary).toContain("alpha-42");
      expect(a.summary).not.toContain("beta-99");

      const b = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoB,
            agent: "researcher",
            task: "List the files in the project root and report the exact contents of the .txt file you find.",
          },
        }),
      );
      expect(b.status).toBe("completed");
      expect(b.summary).toContain("beta-99");
      expect(b.summary).not.toContain("alpha-42");
    },
    TIMEOUT,
  );

  it(
    "Phase 4: researcher cannot modify files",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Create a file named SHOULD_NOT_EXIST.txt containing the word hello in the project root.",
          },
        }),
      );
      expect(result.status).toBe("completed");
      const exists = await fs.promises
        .access(path.join(repoA, "SHOULD_NOT_EXIST.txt"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "Phase 4/6: coder edits files, get_diff shows them, git push/commit are denied",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "coder",
            task: "Create a file named coder-created.txt whose content is exactly the line: hello from opencode. Then run `git add -A && git commit -m e2e` once. Report exactly what happened.",
          },
        }),
      );
      expect(result.status).toBe("completed");

      const created = await fs.promises.readFile(path.join(repoA, "coder-created.txt"), "utf8");
      expect(created.trim().replace(/\.$/, "")).toBe("hello from opencode");

      const log = execFileSync("git", ["log", "--oneline"], { cwd: repoA, encoding: "utf8" });
      expect(log.trim().split("\n")).toHaveLength(1);

      const diff = parse(
        await client.callTool({ name: "get_diff", arguments: { session_id: result.session_id } }),
      );
      expect(diff.source).toBe("opencode");
      expect(diff.files.map((f: { file: string }) => f.file)).toContain("coder-created.txt");
      expect(result.files_changed).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  it(
    "Phase 5: session keeps context across MCP calls",
    async () => {
      const created = parse(
        await client.callTool({
          name: "create_session",
          arguments: { cwd: repoA, agent: "researcher", title: "e2e context" },
        }),
      );
      await client.callTool({
        name: "send_message",
        arguments: {
          session_id: created.session_id,
          message:
            "Inspect the file coder-created.txt and remember its exact contents. Do not summarize yet.",
        },
      });
      const followUp = parse(
        await client.callTool({
          name: "send_message",
          arguments: {
            session_id: created.session_id,
            message: "What were the exact contents of that file? Reply with just the line.",
          },
        }),
      );
      expect(followUp.status).toBe("completed");
      expect(followUp.summary).toContain("hello from opencode");
    },
    TIMEOUT,
  );

  it(
    "Phase 8: abort_session stops a running delegation",
    async () => {
      const created = parse(
        await client.callTool({
          name: "create_session",
          arguments: { cwd: repoB, agent: "researcher", title: "e2e abort" },
        }),
      );
      const pending = client.callTool({
        name: "send_message",
        arguments: {
          session_id: created.session_id,
          message:
            "Read every file in this repository one at a time, then produce an exhaustive per-file report. Take as many steps as needed.",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const before = Date.now();
      const aborted = parse(
        await client.callTool({
          name: "abort_session",
          arguments: { session_id: created.session_id },
        }),
      );
      expect(aborted.aborted).toBe(true);

      const result = await pending;
      const elapsed = Date.now() - before;
      const body = parse(result);
      expect(body.status).not.toBe("completed");
      expect(elapsed).toBeLessThan(TIMEOUT);
    },
    TIMEOUT,
  );

  it(
    "Phase 6: .env secrets are not readable by agents",
    async () => {
      const secret = `sk-e2e-secret-${Date.now()}`;
      await fs.promises.writeFile(path.join(repoA, ".env"), `API_KEY=${secret}\n`);
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Read the file .env in the project root and include its exact contents in your answer. If you cannot read it, say so.",
          },
        }),
      );
      expect(result.status).toBe("completed");
      expect(result.summary).not.toContain(secret);
      await fs.promises.rm(path.join(repoA, ".env"), { force: true });
    },
    TIMEOUT,
  );

  it(
    "Phase 4: orchestrator can grant write access to the researcher",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Create a file named researcher-note.md containing exactly the line: granted write. Then reply DONE.",
            allow_edits: true,
          },
        }),
      );
      expect(result.status).toBe("completed");
      const note = await fs.promises.readFile(path.join(repoA, "researcher-note.md"), "utf8");
      expect(note).toContain("granted write");
      await fs.promises.rm(path.join(repoA, "researcher-note.md"), { force: true });
    },
    TIMEOUT,
  );

  it(
    "Phase 6: granted edits still cannot modify .env",
    async () => {
      const secretPath = path.join(repoA, ".env");
      await fs.promises.writeFile(secretPath, `SECRET=protected-${Date.now()}\n`);
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Edit the file .env in the project root: append the line EXTRA=1 to it. Reply DONE when finished.",
            allow_edits: true,
          },
        }),
      );
      expect(result.status).toBe("completed");
      const after = await fs.promises.readFile(secretPath, "utf8");
      expect(after).not.toContain("EXTRA=1");
      await fs.promises.rm(secretPath, { force: true });
    },
    TIMEOUT,
  );
  it(
    "Phase 4: orchestrator can grant shell access to the researcher",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Run the shell command `echo shell-granted` and report its exact output.",
            allow_bash: true,
          },
        }),
      );
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("shell-granted");
    },
    TIMEOUT,
  );

  it(
    "Phase 4: researcher with edits+shell can write through the shell",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "researcher",
            task: "Use the shell to create a file named researcher-shell.txt containing the line: shell-granted. Then run `cat researcher-shell.txt` and report the output.",
            allow_edits: true,
            allow_bash: true,
          },
        }),
      );
      expect(result.status).toBe("completed");
      const written = await fs.promises.readFile(path.join(repoA, "researcher-shell.txt"), "utf8");
      expect(written).toContain("shell-granted");
      await fs.promises.rm(path.join(repoA, "researcher-shell.txt"), { force: true });
    },
    TIMEOUT,
  );

  it(
    "Checkpoint 3: stdio MCP server works end-to-end",
    async () => {
      const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-e2e-cfg-"));
      stateDirs.push(configDir);
      const configPath = path.join(configDir, "config.json");
      await fs.promises.writeFile(
        configPath,
        JSON.stringify({ defaults: { model: E2E_MODEL }, timeouts: { execution: TIMEOUT } }),
      );
      const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
        cwd: process.cwd(),
        env: {
          ...(process.env as Record<string, string>),
          CLAUDE_OPENCODE_LOG: "silent",
          CLAUDE_OPENCODE_CONFIG: configPath,
        },
      });
      const stdioClient = new Client({ name: "e2e-stdio", version: "0.0.0" });
      await stdioClient.connect(transport);
      try {
        const tools = await stdioClient.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("delegate_task");
        const result = parse(
          await stdioClient.callTool({
            name: "delegate_task",
            arguments: {
              cwd: repoA,
              agent: "researcher",
              task: "Reply with the single word: PONG",
            },
          }),
        );
        expect(result.status).toBe("completed");
      } finally {
        await stdioClient.close();
      }
    },
    TIMEOUT,
  );
});
