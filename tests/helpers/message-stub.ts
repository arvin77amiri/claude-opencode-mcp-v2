import type { MessagePage, SessionInfo, SessionMessage } from "../../src/opencode/api-types.js";

export type RawMessage = { id: string; type: string; [key: string]: unknown };

export interface MessageCall {
  type?: string;
  order?: string;
  cursor?: string;
  limit?: number;
}

/**
 * In-memory stand-in for the read-only OpenCodeClient methods used by session_digest and
 * read_messages. Pages like OpenCode: `order` only on the first request (a cursor together with
 * `order` throws, like the 400 InvalidCursorError), `cursor.next` on every page, and the type
 * filter applies before paging.
 */
export class MessageStub {
  readonly calls: MessageCall[] = [];
  readonly byId: string[] = [];

  constructor(
    readonly all: RawMessage[],
    private readonly session: Partial<SessionInfo> = {},
    private readonly options: { failType?: string } = {},
  ) {}

  async getSession(sessionId: string): Promise<SessionInfo> {
    return { id: sessionId, title: "Stub session", ...this.session } as SessionInfo;
  }

  async messages(
    _sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string },
  ): Promise<MessagePage> {
    this.calls.push({ ...query });
    if (query.cursor && query.order) throw new Error("400 InvalidCursorError");
    if (query.type && this.options.failType === query.type) throw new Error("boom");
    const [order, offsetText] = query.cursor
      ? query.cursor.split(":")
      : [query.order ?? "asc", "0"];
    const offset = Number(offsetText);
    let list = this.all.filter((message) => !query.type || message.type === query.type);
    if (order === "desc") list = [...list].reverse();
    const limit = query.limit ?? list.length;
    return {
      data: list.slice(offset, offset + limit) as unknown as SessionMessage[],
      cursor: { next: `${order}:${offset + limit}` },
    };
  }

  async message(_sessionId: string, messageId: string): Promise<SessionMessage | null> {
    this.byId.push(messageId);
    return (this.all.find((message) => message.id === messageId) ??
      null) as unknown as SessionMessage | null;
  }

  /** No request combined `order` with `cursor`. */
  get neverOrderWithCursor(): boolean {
    return this.calls.every((call) => !(call.order && call.cursor));
  }
}

export const user = (id: string, text: string, created = 1): RawMessage => ({
  id,
  type: "user",
  text,
  time: { created },
});

export const assistant = (
  id: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  created = 1,
): RawMessage => ({ id, type: "assistant", content, time: { created }, ...extra });

export const text = (value: string) => ({ type: "text", text: value });

export const tool = (
  name: string,
  input: Record<string, unknown>,
  state: Record<string, unknown> = { status: "completed" },
) => ({ type: "tool", id: `t_${name}`, name, state: { ...state, input } });

export const idle = (id: string, outcome: string, error?: unknown, created = 1): RawMessage => ({
  id,
  type: "idle",
  outcome,
  ...(error ? { error } : {}),
  time: { created },
});

export const compaction = (id: string, summary: string, created = 1): RawMessage => ({
  id,
  type: "compaction",
  summary,
  time: { created },
});
