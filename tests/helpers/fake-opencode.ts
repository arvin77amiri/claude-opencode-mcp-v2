import http from "node:http";
import type { AddressInfo } from "node:net";
import { BUILTIN_AGENT_NAMES, VARIANT_SEPARATOR } from "../../src/opencode/agents.js";
import type { FileDiff, ModelRef, PermissionRuleset } from "../../src/opencode/api-types.js";

export interface FakeAgent {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
}

export interface FakePromptRequest {
  sessionId: string;
  directory: string;
  agent?: string;
  model?: ModelRef;
  permissions?: PermissionRuleset;
  text: string;
}

export interface FakePromptResponse {
  text: string;
  delayMs?: number;
  /** Error payload attached to the assistant message and the idle message (outcome failed). */
  error?: { name: string; data: Record<string, unknown> };
  /** Emit a completed tool-call step before the final message (real OpenCode behavior). */
  toolStep?: boolean;
  /** Do not emit SSE events (forces the bridge onto its polling fallback). */
  silent?: boolean;
  onBeforeRespond?: () => Promise<void> | void;
}

export interface FakeOpenCodeOptions {
  version?: string;
  agents?: FakeAgent[];
  /** When set, POST /api/session reports this directory instead of the requested one. */
  reportedDirectory?: string;
  /** Password for HTTP Basic auth (user `opencode`); no auth when undefined. */
  password?: string;
  /**
   * Mimics OpenCode 2's config warm-up: `GET /api/agent/{id}` answers 404 for
   * this many ms after `listen()`, even for agents that exist.
   */
  agentWarmupMs?: number;
  /** Model catalog; defaults to deepseek/deepseek-v4-pro only. */
  models?: Array<{ id: string; providerID: string }>;
  diff?: FileDiff[];
  onPrompt?: (request: FakePromptRequest) => FakePromptResponse | Promise<FakePromptResponse>;
}

interface FakeMessage {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface FakeSession {
  id: string;
  directory: string;
  title: string;
  agent?: string;
  model?: ModelRef;
  permissions: PermissionRuleset;
  messages: FakeMessage[];
  running: boolean;
  interrupted: boolean;
}

const VARIANT_SUFFIXES = ["ro", "edit", "bash", "rw"] as const;

// Bases plus every permission variant the bridge can generate.
const DEFAULT_AGENTS: FakeAgent[] = BUILTIN_AGENT_NAMES.flatMap((base) => [
  { name: base, description: `fake ${base}`, mode: "all" as const },
  ...VARIANT_SUFFIXES.map((suffix) => ({
    name: `${base}${VARIANT_SEPARATOR}${suffix}`,
    description: `fake ${base} ${suffix}`,
    mode: "all" as const,
  })),
]);

export class FakeOpenCode {
  readonly server: http.Server;
  readonly prompts: FakePromptRequest[] = [];
  /** Requests received on v1-style routes (the bridge must never use them). */
  legacyCalls = 0;
  /** Permission replies received: [sessionId, requestId, decision]. */
  readonly permissionReplies: Array<[string, string, string]> = [];
  /** Pending permission requests per session, returned by GET .../permission. */
  readonly pendingPermissions = new Map<string, Array<Record<string, unknown>>>();
  readonly sessions = new Map<string, FakeSession>();
  readonly agents: FakeAgent[];
  readonly version: string;
  readonly authHeaders: string[] = [];
  private readonly options: FakeOpenCodeOptions;
  private readonly streams = new Set<http.ServerResponse>();
  private counter = 0;
  private listenedAt = 0;
  /** Number of `GET /api/agent/{id}` requests answered with 404 during warm-up. */
  warmupMisses = 0;

  constructor(options: FakeOpenCodeOptions = {}) {
    this.options = options;
    this.version = options.version ?? "2.0.22-fake";
    this.agents = options.agents ?? DEFAULT_AGENTS;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ _tag: "InternalError", message: String(error) }));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.listenedAt = Date.now();
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Emit an SSE event to every open stream. */
  emit(type: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({
      id: `evt_${++this.counter}`,
      created: Date.now(),
      type,
      data,
    });
    for (const stream of this.streams) stream.write(`data: ${payload}\n\n`);
  }

  private nextId(prefix: string): string {
    return `${prefix}_${String(++this.counter).padStart(10, "0")}`;
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private json(res: http.ServerResponse, value: unknown, status = 200): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  }

  private async interruptibleDelay(session: FakeSession, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (session.interrupted) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  }

  private async execute(
    session: FakeSession,
    request: FakePromptRequest,
    userId: string,
  ): Promise<void> {
    const response = (await this.options.onPrompt?.(request)) ?? {
      text: `FAKE DONE: ${request.text.slice(0, 80)}`,
    };
    const emit = (type: string, extra: Record<string, unknown> = {}) => {
      if (!response.silent) this.emit(type, { sessionID: session.id, ...extra });
    };
    emit("session.execution.started");

    if (response.toolStep && !session.interrupted) {
      session.messages.push({
        id: this.nextId("msg"),
        type: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        content: [
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: { status: "completed", input: { path: "README.md" } },
          },
        ],
        finish: "tool-calls",
      });
      emit("session.tool.called", { name: "read" });
      await this.interruptibleDelay(session, 100);
    }

    if (response.delayMs) await this.interruptibleDelay(session, response.delayMs);
    if (response.onBeforeRespond) await response.onBeforeRespond();

    const interrupted = session.interrupted;
    const failed = !interrupted && response.error !== undefined;
    if (!interrupted) {
      session.messages.push({
        id: this.nextId("msg"),
        type: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        content: response.text ? [{ type: "text", text: response.text }] : [],
        finish: failed ? "error" : "stop",
        ...(failed ? { error: response.error } : {}),
      });
    }
    const outcome = interrupted ? "interrupted" : failed ? "failed" : "succeeded";
    session.messages.push({
      id: this.nextId("msg"),
      type: "idle",
      outcome,
      time: { created: Date.now() },
    });
    session.running = false;
    void userId;
    emit(`session.execution.${outcome}`);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const { password } = this.options;
    const header = req.headers.authorization ?? "";
    this.authHeaders.push(header);
    if (password === undefined) return true;
    return header === `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    if (!pathname.startsWith("/api/")) {
      // OpenCode 2 serves its SPA (HTML, HTTP 200) for every unknown route.
      this.legacyCalls += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html><body>opencode</body></html>");
      return;
    }

    if (!this.authorized(req)) {
      this.json(res, { _tag: "UnauthorizedError", message: "Authentication required" }, 401);
      return;
    }

    if (pathname === "/api/info" && method === "GET") {
      this.json(res, { data: { version: this.version, pid: process.pid, urls: [], paths: {} } });
      return;
    }

    if (pathname === "/api/agent" && method === "GET") {
      this.json(res, {
        data: this.agents.map((agent) => ({
          id: agent.name,
          name: agent.name,
          description: agent.description ?? "",
          mode: agent.mode,
          hidden: false,
          permissions: [],
        })),
      });
      return;
    }

    const agentMatch = pathname.match(/^\/api\/agent\/([^/]+)$/);
    if (agentMatch && method === "GET") {
      const id = decodeURIComponent(agentMatch[1]!);
      const agent = this.agents.find((entry) => entry.name === id);
      const warmingUp = Date.now() - this.listenedAt < (this.options.agentWarmupMs ?? 0);
      if (warmingUp && agent) this.warmupMisses += 1;
      if (!agent || warmingUp) {
        this.json(res, { _tag: "AgentNotFoundError", message: id }, 404);
        return;
      }
      this.json(res, {
        data: { id, name: id, mode: agent.mode, hidden: false, permissions: [] },
      });
      return;
    }

    const models = this.options.models ?? [{ id: "deepseek-v4-pro", providerID: "deepseek" }];
    if (pathname === "/api/model" && method === "GET") {
      this.json(res, { data: models });
      return;
    }
    if (pathname === "/api/model/default" && method === "GET") {
      this.json(res, { data: models[0] ?? null });
      return;
    }

    if (pathname === "/api/event" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write('data: {"id":"evt_0","type":"server.connected","data":{}}\n\n');
      this.streams.add(res);
      req.on("close", () => this.streams.delete(res));
      return;
    }

    if (pathname === "/api/session" && method === "POST") {
      const body = await this.readBody(req);
      const directory =
        (body.location as { directory?: string } | undefined)?.directory ?? process.cwd();
      const id = this.nextId("ses");
      const session: FakeSession = {
        id,
        directory,
        title: typeof body.title === "string" ? body.title : "fake session",
        ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
        ...(body.model ? { model: body.model as ModelRef } : {}),
        permissions: (body.permissions as PermissionRuleset | undefined) ?? [],
        messages: [],
        running: false,
        interrupted: false,
      };
      this.sessions.set(id, session);
      this.json(res, {
        data: { id, title: session.title, time: { created: Date.now(), updated: Date.now() } },
        location: { directory: this.options.reportedDirectory ?? directory },
      });
      return;
    }

    if (pathname === "/api/session/active" && method === "GET") {
      const data: Record<string, unknown> = {};
      for (const session of this.sessions.values()) {
        if (session.running) data[session.id] = { type: "running" };
      }
      this.json(res, { data });
      return;
    }

    const match = pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]!);
      const sub = match[2] ?? "";
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.json(
          res,
          { _tag: "SessionNotFoundError", sessionID: sessionId, message: "nope" },
          404,
        );
        return;
      }

      if (sub === "" && method === "GET") {
        this.json(res, {
          data: {
            id: session.id,
            title: session.title,
            time: { created: Date.now(), updated: Date.now() },
          },
          location: { directory: session.directory },
        });
        return;
      }
      if (sub === "" && method === "PATCH") {
        const body = await this.readBody(req);
        if (Array.isArray(body.permissions)) session.permissions = body.permissions;
        res.statusCode = 204;
        res.end();
        return;
      }
      if (sub === "/agent" && method === "POST") {
        const body = await this.readBody(req);
        session.agent = String(body.agent);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (sub === "/prompt" && method === "POST") {
        const body = await this.readBody(req);
        session.running = true;
        session.interrupted = false;
        const userId = this.nextId("msg");
        const text = String(body.text ?? "");
        session.messages.push({ id: userId, type: "user", text, time: { created: Date.now() } });
        const request: FakePromptRequest = {
          sessionId: session.id,
          directory: session.directory,
          ...(session.agent ? { agent: session.agent } : {}),
          ...(session.model ? { model: session.model } : {}),
          permissions: session.permissions,
          text,
        };
        this.prompts.push(request);
        void this.execute(session, request, userId).catch(() => {
          session.running = false;
        });
        this.json(res, { data: { id: userId, type: "user", text, time: { created: Date.now() } } });
        return;
      }

      if (sub === "/message" && method === "GET") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        const order = url.searchParams.get("order") ?? "asc";
        let list = [...session.messages];
        if (order === "desc") list.reverse();
        if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit);
        this.json(res, { data: list, cursor: {} });
        return;
      }

      if (sub === "/diff" && method === "GET") {
        this.json(res, { data: this.options.diff ?? [] });
        return;
      }

      if (sub === "/interrupt" && method === "POST") {
        const wasRunning = session.running;
        session.interrupted = true;
        this.json(res, { data: { interrupted: wasRunning } });
        return;
      }

      if (sub === "/permission" && method === "GET") {
        this.json(res, { data: this.pendingPermissions.get(session.id) ?? [] });
        return;
      }

      const reply = sub.match(/^\/permission\/([^/]+)\/reply$/);
      if (reply && method === "POST") {
        const body = await this.readBody(req);
        this.permissionReplies.push([session.id, reply[1]!, String(body.decision)]);
        const pending = this.pendingPermissions.get(session.id) ?? [];
        this.pendingPermissions.set(
          session.id,
          pending.filter((entry) => entry.id !== reply[1]),
        );
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    this.json(res, { _tag: "NotFoundError", message: `${method} ${pathname}` }, 404);
  }
}
