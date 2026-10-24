import { describe, expect, it } from "vitest";
import type {
  MessagePage,
  SessionInfo,
  SessionListPage,
  SessionListQuery,
} from "../../src/opencode/api-types.js";
import {
  fitToBudget,
  pageSessions,
  type SessionHit,
  type SessionSearchClient,
  searchSessions,
} from "../../src/opencode/session-search.js";

type RawMessage = { id: string; type: string; [key: string]: unknown };

class StubClient implements SessionSearchClient {
  readonly listCalls: SessionListQuery[] = [];
  readonly messageCalls: Array<{ sessionId: string; type?: string }> = [];

  constructor(
    private readonly sessions: SessionInfo[],
    private readonly messagesBySession: Record<string, RawMessage[]> = {},
    private readonly options: { messageDelayMs?: number; failMessages?: boolean } = {},
  ) {}

  async listSessions(query: SessionListQuery): Promise<SessionListPage> {
    this.listCalls.push({ ...query });
    const search = query.search?.toLowerCase();
    const all = this.sessions
      .filter((session) => !search || (session.title ?? "").toLowerCase().includes(search))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const offset = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 50;
    // Like OpenCode: cursor.next is returned even on the last page.
    return { data: all.slice(offset, offset + limit), cursor: { next: String(offset + limit) } };
  }

  async messages(
    sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; type?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<MessagePage> {
    this.messageCalls.push({ sessionId, ...(query.type ? { type: query.type } : {}) });
    if (this.options.messageDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.messageDelayMs);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    }
    if (this.options.failMessages) throw new Error("400 invalid type filter");
    let list = (this.messagesBySession[sessionId] ?? []).filter(
      (message) => !query.type || message.type === query.type,
    );
    if (query.order === "desc") list = [...list].reverse();
    return { data: list.slice(0, query.limit ?? list.length) };
  }
}

function session(index: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: `ses_${String(index).padStart(3, "0")}`,
    title: `Session ${index}`,
    time: { created: index * 1_000 - 500, updated: index * 1_000 },
    ...extra,
  };
}

/** n sessions, ses_<n> is the newest. */
function sessions(count: number): SessionInfo[] {
  return Array.from({ length: count }, (_, index) => session(index + 1));
}

function userMessage(id: string, text: string): RawMessage {
  return { id, type: "user", text, time: { created: 1 } };
}

describe("pageSessions", () => {
  it("follows the cursor, sends order on the first page only and stops on a short page", async () => {
    const client = new StubClient(sessions(120));
    const result = await pageSessions(client, { project: "prj" }, { want: 500, pageSize: 50 });
    expect(result).toHaveLength(120);
    expect(result[0]?.id).toBe("ses_120");
    expect(client.listCalls).toHaveLength(3);
    expect(client.listCalls[0]).toMatchObject({ limit: 50, order: "desc" });
    for (const call of client.listCalls.slice(1)) {
      expect(call.cursor).toBeDefined();
      expect(call.order).toBeUndefined();
    }
    for (const call of client.listCalls) {
      expect(call.order !== undefined && call.cursor !== undefined).toBe(false);
    }
  });

  it("needs one extra (empty) page when the total is an exact multiple of the page size", async () => {
    const client = new StubClient(sessions(100));
    await pageSessions(client, { project: "prj" }, { want: 500, pageSize: 50 });
    expect(client.listCalls).toHaveLength(3);
  });

  it("stops as soon as enough sessions were collected", async () => {
    const client = new StubClient(sessions(120));
    const result = await pageSessions(client, { project: "prj" }, { want: 7, pageSize: 50 });
    expect(result).toHaveLength(7);
    expect(client.listCalls).toHaveLength(1);
  });

  it("skips sub-agent child sessions and keeps paging to fill the request", async () => {
    const all = sessions(40).map((entry, index) =>
      index % 2 === 0 ? { ...entry, parentID: "ses_parent" } : entry,
    );
    const client = new StubClient(all);
    const result = await pageSessions(client, { project: "prj" }, { want: 15, pageSize: 10 });
    expect(result).toHaveLength(15);
    expect(result.every((entry) => entry.parentID === undefined)).toBe(true);
    expect(client.listCalls.length).toBeGreaterThan(1);
  });

  it("passes the project and title search through", async () => {
    const client = new StubClient(sessions(10));
    await pageSessions(client, { project: "prj", search: "Session 3" }, { want: 5 });
    expect(client.listCalls[0]).toMatchObject({ project: "prj", search: "Session 3" });
  });
});

describe("searchSessions", () => {
  const all = sessions(30);
  const messages: Record<string, RawMessage[]> = {
    ses_030: [userMessage("msg_30a", "work on the parser")],
    ses_029: [
      userMessage("msg_29a", "why is deploy flaky?"),
      {
        id: "msg_29b",
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "needle only in reasoning" },
          {
            type: "tool",
            id: "t1",
            name: "read",
            state: {
              status: "completed",
              input: { path: "a.ts" },
              content: [{ type: "text", text: "needle only in tool output" }],
            },
          },
          { type: "text", text: "The deploy script retries the NEEDLE step twice." },
        ],
      },
    ],
    ses_026: [userMessage("msg_26a", "needle in an older session")],
    ses_005: [userMessage("msg_05a", "needle far outside the scan window")],
  };

  it("returns the most recent root sessions without a query", async () => {
    const client = new StubClient([...all, session(31, { parentID: "ses_030" })], messages);
    const result = await searchSessions(client, { project: "prj", limit: 3, scan: 20 });
    expect(result.sessions.map((hit) => hit.session_id)).toEqual(["ses_030", "ses_029", "ses_028"]);
    expect(result.sessions[0]).toMatchObject({ title: "Session 30" });
    expect(result.sessions[0]?.match).toBeUndefined();
    expect(result.scanned).toBe(0);
    expect(result.partial).toBe(false);
    expect(client.messageCalls).toHaveLength(0);
  });

  it("finds content matches in the filtered text of the scan window only", async () => {
    const client = new StubClient(all, messages);
    const result = await searchSessions(client, {
      project: "prj",
      query: "needle",
      limit: 10,
      scan: 10,
    });
    // ses_030..ses_021 are scanned: the match in ses_029 comes from assistant TEXT (not from
    // reasoning or tool output) and ses_026 from a user message; ses_005 is outside the window.
    expect(result.sessions.map((hit) => hit.session_id)).toEqual(["ses_029", "ses_026"]);
    expect(result.sessions[0]).toMatchObject({
      match: "content",
      message_ids: ["msg_29b"],
    });
    expect(result.sessions[0]?.snippet).toContain("NEEDLE step twice");
    expect(result.sessions[0]?.snippet?.length).toBeLessThanOrEqual(200);
    expect(result.scanned).toBe(10);
    expect(result.partial).toBe(false);
    expect(client.messageCalls.some((call) => call.sessionId === "ses_005")).toBe(false);
    expect(client.messageCalls.every((call) => call.type !== undefined)).toBe(true);
  });

  it("puts title matches first and does not scan them again", async () => {
    // ses_029 is inside the scan window and its content matches too, but its title wins.
    const titled = all.map((entry) =>
      entry.id === "ses_029" ? { ...entry, title: "Needle investigation" } : entry,
    );
    const client = new StubClient(titled, messages);
    const result = await searchSessions(client, {
      project: "prj",
      query: "needle",
      limit: 10,
      scan: 10,
    });
    expect(result.sessions.map((hit) => [hit.session_id, hit.match])).toEqual([
      ["ses_029", "title"],
      ["ses_026", "content"],
    ]);
    expect(result.sessions[0]?.title).toBe("Needle investigation");
    expect(result.sessions[0]?.snippet).toBeUndefined();
    expect(client.messageCalls.some((call) => call.sessionId === "ses_029")).toBe(false);
    // the title search is sent to the server as `search`
    expect(client.listCalls.some((call) => call.search === "needle")).toBe(true);
  });

  it("stops scanning once the limit is reached and is not partial", async () => {
    const client = new StubClient(all, messages);
    const result = await searchSessions(client, {
      project: "prj",
      query: "needle",
      limit: 1,
      scan: 20,
      concurrency: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(result.scanned).toBeLessThan(20);
  });

  it("returns what it has and partial: true when the time budget runs out", async () => {
    const client = new StubClient(all, messages, { messageDelayMs: 150 });
    const started = Date.now();
    const result = await searchSessions(client, {
      project: "prj",
      query: "needle",
      limit: 10,
      scan: 20,
      concurrency: 1,
      budgetMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.partial).toBe(true);
    expect(result.scanned).toBeLessThan(20);
  });

  it("reports sessions whose messages could not be read instead of hiding the failure", async () => {
    const client = new StubClient(all, messages, { failMessages: true });
    const result = await searchSessions(client, {
      project: "prj",
      query: "needle",
      limit: 10,
      scan: 4,
    });
    expect(result.sessions).toEqual([]);
    expect(result.scan_errors).toBe(4);
    expect(result.scan_error).toContain("invalid type filter");
  });
});

describe("fitToBudget", () => {
  function hit(index: number): SessionHit {
    return {
      session_id: `ses_${index}`,
      title: `A reasonably long session title number ${index}`,
      updated: "2026-10-24T10:00:00.000Z",
      outcome: "succeeded",
      match: "content",
      snippet: "s".repeat(200),
      message_ids: ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"],
    };
  }

  it("returns small payloads untouched", () => {
    const payload = { sessions: [hit(1)] };
    expect(fitToBudget(payload, 4_000)).toBe(payload);
  });

  it("keeps the compact JSON under the budget by shortening, then dropping", () => {
    const payload = {
      project: { id: "prj", name: "Demo" },
      partial: false,
      sessions: Array.from({ length: 25 }, (_, index) => hit(index)),
    };
    const fitted = fitToBudget(payload, 4_000) as typeof payload & {
      truncated?: boolean;
      omitted?: number;
    };
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(4_000);
    expect(fitted.truncated).toBe(true);
    expect(fitted.sessions.length).toBeGreaterThan(0);
    expect(fitted.sessions.length + (fitted.omitted ?? 0)).toBe(25);
    // the newest hits survive
    expect(fitted.sessions[0]?.session_id).toBe("ses_0");
  });
});
