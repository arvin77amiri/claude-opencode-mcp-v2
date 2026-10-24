import { BridgeError } from "../errors.js";
import type {
  ActiveSessions,
  AgentInfo,
  CreateSessionBody,
  Envelope,
  FileDiff,
  MessagePage,
  ModelInfo,
  PatchSessionBody,
  PermissionReply,
  PermissionRequest,
  ProjectInfo,
  PromptBody,
  ServerEvent,
  ServerInfo,
  SessionInfo,
  SessionListPage,
  SessionListQuery,
  SessionMessage,
} from "./api-types.js";

export interface AuthCredentials {
  username: string;
  password: string;
}

export function basicAuthHeader(credentials: AuthCredentials): string {
  const raw = `${credentials.username}:${credentials.password}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function summarize(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  try {
    return (JSON.stringify(body) ?? "").slice(0, 200);
  } catch {
    return String(body);
  }
}

/** Non-2xx answer from the OpenCode API. */
export class OpenCodeApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(status: number, path: string, body: unknown) {
    super(`OpenCode API ${status} on ${path}: ${summarize(body)}`);
    this.name = "OpenCodeApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  auth?: AuthCredentials | null;
  /** Per-request timeout for ordinary (non-streaming) calls. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const JSON_CONTENT_TYPE = /application\/(?:[\w.+-]*\+)?json/i;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function unwrap<T>(body: Envelope<T> | T): T {
  if (body && typeof body === "object" && "data" in body) return (body as Envelope<T>).data;
  return body as T;
}

function unauthorized(baseUrl: string): BridgeError {
  return new BridgeError(
    "OPENCODE_UNAVAILABLE",
    "OpenCode rejected the credentials (HTTP 401). Check opencode.username/password.",
    { details: { url: baseUrl } },
  );
}

/**
 * Minimal typed `fetch` client for the OpenCode v2 HTTP API (`/api/*`).
 *
 * Every non-streaming response must be `application/json` (or 204): OpenCode 2
 * answers unknown v1 routes with its SPA HTML and HTTP 200, which would
 * otherwise be mistaken for a valid reply.
 */
export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly auth: AuthCredentials | null;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.auth = options.auth ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.auth) headers.authorization = basicAuthHeader(this.auth);
    return headers;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Perform a request and return the parsed JSON body (`null` for 204). */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.url(path, options.query), {
        method,
        headers: this.headers({
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        }),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        `OpenCode request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, retryable: true },
      );
    }

    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw unauthorized(this.baseUrl);
    }
    if (response.status === 204) return null as T;

    const contentType = response.headers.get("content-type") ?? "";
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      const text = await response.text().catch(() => "");
      throw new BridgeError(
        "OPENCODE_ERROR",
        `OpenCode returned a non-JSON response (${response.status} ${contentType || "no content-type"}) for ${method} ${path}. ` +
          "The server is probably not OpenCode 2.x, or the route does not exist.",
        { details: { status: response.status, contentType, preview: text.slice(0, 120) } },
      );
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new OpenCodeApiError(response.status, path, body);
    return body as T;
  }

  // ---- server -----------------------------------------------------------

  async info(): Promise<ServerInfo> {
    return unwrap(await this.request<Envelope<ServerInfo> | ServerInfo>("GET", "/api/info"));
  }

  // ---- sessions ---------------------------------------------------------

  async createSession(body: CreateSessionBody): Promise<SessionInfo> {
    const result = await this.request<Envelope<SessionInfo>>("POST", "/api/session", { body });
    const info = unwrap<SessionInfo>(result);
    if (!info?.id) {
      throw new BridgeError("OPENCODE_ERROR", "OpenCode did not return a session id.", {
        details: { response: result },
      });
    }
    // The location lives on the envelope in most responses.
    if (!info.location && result.location) info.location = result.location;
    return info;
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    return unwrap(
      await this.request<Envelope<SessionInfo>>("GET", `/api/session/${enc(sessionId)}`),
    );
  }

  async patchSession(sessionId: string, body: PatchSessionBody): Promise<void> {
    await this.request("PATCH", `/api/session/${enc(sessionId)}`, { body });
  }

  async setSessionAgent(sessionId: string, agent: string): Promise<void> {
    await this.request("POST", `/api/session/${enc(sessionId)}/agent`, { body: { agent } });
  }

  async activeSessions(): Promise<ActiveSessions> {
    const result = await this.request<Envelope<ActiveSessions>>("GET", "/api/session/active");
    return result?.data ?? {};
  }

  /** Queue a prompt; returns as soon as the server accepted it. */
  async prompt(sessionId: string, body: PromptBody): Promise<SessionMessage | null> {
    const result = await this.request<Envelope<SessionMessage> | null>(
      "POST",
      `/api/session/${enc(sessionId)}/prompt`,
      { body },
    );
    return result?.data ?? null;
  }

  async messages(
    sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<MessagePage> {
    // The API rejects `order` together with `cursor`; the cursor already fixes the direction.
    const { order, ...rest } = query;
    const page = await this.request<MessagePage>("GET", `/api/session/${enc(sessionId)}/message`, {
      query: query.cursor ? rest : { ...rest, ...(order ? { order } : {}) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { data: page?.data ?? [], ...(page?.cursor ? { cursor: page.cursor } : {}) };
  }

  /**
   * `GET /api/session/{id}/message/{messageID}` (read-only). Null when the message does not
   * exist; an unknown session still throws (404 SessionNotFoundError).
   */
  async message(
    sessionId: string,
    messageId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionMessage | null> {
    try {
      const result = await this.request<Envelope<SessionMessage>>(
        "GET",
        `/api/session/${enc(sessionId)}/message/${enc(messageId)}`,
        { ...(options.signal ? { signal: options.signal } : {}) },
      );
      return result?.data ?? null;
    } catch (error) {
      const body = error instanceof OpenCodeApiError ? error.body : undefined;
      const tag =
        typeof body === "object" && body !== null ? (body as { _tag?: unknown })._tag : undefined;
      if (
        error instanceof OpenCodeApiError &&
        error.status === 404 &&
        tag !== "SessionNotFoundError"
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * `GET /api/session` (read-only). `search` matches titles only. `order` is sent on the first
   * page only: with a `cursor` the API answers 400 InvalidCursorError. The server always returns
   * `cursor.next`, so the end of paging is a page with fewer items than `limit`.
   */
  async listSessions(
    query: SessionListQuery = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionListPage> {
    const { order, cursor, limit, ...filters } = query;
    const page = await this.request<SessionListPage>("GET", "/api/session", {
      query: {
        ...filters,
        ...(limit !== undefined ? { limit: String(limit) } : {}),
        ...(cursor ? { cursor } : order ? { order } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const next = page?.cursor?.next;
    return {
      data: Array.isArray(page?.data) ? page.data : [],
      ...(next ? { cursor: { next } } : {}),
    };
  }

  /** `GET /api/project` (read-only). */
  async projects(options: { signal?: AbortSignal } = {}): Promise<ProjectInfo[]> {
    const result = await this.request<ProjectInfo[] | Envelope<ProjectInfo[]>>(
      "GET",
      "/api/project",
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    const list = Array.isArray(result) ? result : result?.data;
    return Array.isArray(list) ? list : [];
  }

  /** Number of sessions of a project (`GET /api/experimental/session/stats`, read-only). */
  async sessionCount(project: string, options: { signal?: AbortSignal } = {}): Promise<number> {
    const result = await this.request<Envelope<{ sessions?: number }>>(
      "GET",
      "/api/experimental/session/stats",
      { query: { project }, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return result?.data?.sessions ?? 0;
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const result = await this.request<Envelope<{ interrupted?: boolean }> | null>(
      "POST",
      `/api/session/${enc(sessionId)}/interrupt`,
    );
    return result?.data?.interrupted ?? true;
  }

  async diff(sessionId: string): Promise<FileDiff[]> {
    const result = await this.request<Envelope<FileDiff[]>>(
      "GET",
      `/api/session/${enc(sessionId)}/diff`,
    );
    return Array.isArray(result?.data) ? result.data : [];
  }

  // ---- catalog ----------------------------------------------------------

  async agents(): Promise<AgentInfo[]> {
    const result = await this.request<Envelope<AgentInfo[]>>("GET", "/api/agent");
    return Array.isArray(result?.data) ? result.data : [];
  }

  /** `GET /api/agent/{id}`; null when the agent does not exist (404). */
  async agent(id: string): Promise<AgentInfo | null> {
    try {
      const result = await this.request<Envelope<AgentInfo>>("GET", `/api/agent/${enc(id)}`);
      return result?.data ?? null;
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async defaultModel(): Promise<ModelInfo | null> {
    const result = await this.request<Envelope<ModelInfo | null>>("GET", "/api/model/default");
    return result?.data ?? null;
  }

  async models(): Promise<ModelInfo[]> {
    const result = await this.request<Envelope<ModelInfo[]>>("GET", "/api/model");
    return Array.isArray(result?.data) ? result.data : [];
  }

  // ---- permissions ------------------------------------------------------

  async pendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
    const result = await this.request<Envelope<PermissionRequest[]>>(
      "GET",
      `/api/session/${enc(sessionId)}/permission`,
    );
    return Array.isArray(result?.data) ? result.data : [];
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionReply,
    message?: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${enc(sessionId)}/permission/${enc(requestId)}/reply`,
      { body: { decision, ...(message ? { message } : {}) } },
    );
  }

  // ---- events (SSE) -----------------------------------------------------

  /**
   * Open `GET /api/event`. Resolves once the stream is established and returns
   * an async generator of parsed events that ends when the stream closes or
   * `signal` aborts.
   */
  async openEvents(signal: AbortSignal): Promise<AsyncGenerator<ServerEvent, void, void>> {
    const response = await fetch(this.url("/api/event"), {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`event stream unavailable (${response.status} ${contentType})`);
    }
    return parseSse(response.body, signal);
  }
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export function parseSseBlock(block: string): ServerEvent | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as ServerEvent;
    if (parsed && typeof parsed.type === "string") {
      return { ...parsed, data: parsed.data ?? {} };
    }
  } catch {
    // ignore malformed event
  }
  return null;
}

export interface HealthResult {
  healthy: boolean;
  version: string;
}

/** Probe `GET /api/info`. Returns null when unreachable, unauthorized or not OpenCode 2. */
export async function fetchHealth(
  baseUrl: string,
  auth?: AuthCredentials | null,
): Promise<HealthResult | null> {
  try {
    const client = new OpenCodeClient({ baseUrl, auth: auth ?? null, timeoutMs: 10_000 });
    const info = await client.info();
    if (!info || typeof info.version !== "string") return null;
    return { healthy: true, version: info.version };
  } catch {
    return null;
  }
}
