import type { MessagePage, SessionInfo, SessionListPage, SessionListQuery } from "./api-types.js";
import {
  type CompactMessage,
  DEFAULT_FILTER_LIMITS,
  findContentMatch,
  normalizeMessages,
} from "./session-filter.js";

/** The read-only slice of OpenCodeClient that session search needs. */
export interface SessionSearchClient {
  listSessions(
    query: SessionListQuery,
    options?: { signal?: AbortSignal },
  ): Promise<SessionListPage>;
  messages(
    sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string },
    options?: { signal?: AbortSignal },
  ): Promise<MessagePage>;
}

/** Messages read per scanned session (one GET per type). Tuned by the live check. */
export const SCAN_USER_LIMIT = 40;
export const SCAN_ASSISTANT_LIMIT = 20;
export const SCAN_COMPACTION_LIMIT = 5;

const MAX_TITLE_CHARS = 100;
const MAX_PAGES = 10;

export interface PageOptions {
  /** Stop once this many sessions were kept. */
  want: number;
  /** Items requested per page (a string `limit` on the wire). */
  pageSize?: number;
  maxPages?: number;
  signal?: AbortSignal;
  /** Drop sessions after fetching (default: keep root sessions, drop sub-agent children). */
  keep?: (session: SessionInfo) => boolean;
}

export function isRootSession(session: SessionInfo): boolean {
  return !session.parentID;
}

/**
 * Newest-first sessions of a project, following the cursor. `order` goes on the first request
 * only (the API answers 400 when it is sent together with `cursor`). `cursor.next` is always
 * returned, so the end is a page with fewer items than `limit`.
 */
export async function pageSessions(
  client: Pick<SessionSearchClient, "listSessions">,
  filters: { project: string; search?: string },
  options: PageOptions,
): Promise<SessionInfo[]> {
  const pageSize = options.pageSize ?? Math.min(100, Math.max(20, options.want * 2));
  const maxPages = options.maxPages ?? MAX_PAGES;
  const keep = options.keep ?? isRootSession;
  const kept: SessionInfo[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages && kept.length < options.want; page += 1) {
    if (options.signal?.aborted) break;
    const result = await client.listSessions(
      {
        ...filters,
        limit: pageSize,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      },
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    for (const session of result.data) {
      if (keep(session)) kept.push(session);
      if (kept.length >= options.want) break;
    }
    cursor = result.cursor?.next;
    if (result.data.length < pageSize || !cursor) break;
  }
  return kept;
}

export interface SessionHit {
  session_id: string;
  title: string;
  updated?: string;
  outcome?: string;
  match?: "title" | "content";
  snippet?: string;
  message_ids?: string[];
}

export interface SearchOptions {
  project: string;
  query?: string;
  limit: number;
  scan: number;
  budgetMs?: number;
  concurrency?: number;
  snippetChars?: number;
}

export interface SearchResult {
  sessions: SessionHit[];
  /** Sessions whose messages were read and searched. */
  scanned: number;
  /** The time budget ran out before every session of the scan window was searched. */
  partial: boolean;
  /** Sessions whose messages could not be read (and the first reason). */
  scan_errors?: number;
  scan_error?: string;
}

function shortTitle(title: string | undefined): string {
  const flat = (title ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS)}…` : flat;
}

function toHit(session: SessionInfo, extra: Partial<SessionHit> = {}): SessionHit {
  const updated = session.time?.updated;
  return {
    session_id: session.id,
    title: shortTitle(session.title),
    ...(typeof updated === "number" ? { updated: new Date(updated).toISOString() } : {}),
    ...(session.outcome ? { outcome: session.outcome } : {}),
    ...extra,
  };
}

/** Read the filtered text of one session: its first prompts, compactions and latest steps. */
export async function fetchSessionText(
  client: Pick<SessionSearchClient, "messages">,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ messages: CompactMessage[]; failures: string[] }> {
  const options = signal ? { signal } : {};
  const failures: string[] = [];
  const read = async (type: string, limit: number, order: "asc" | "desc"): Promise<unknown[]> => {
    try {
      return (await client.messages(sessionId, { type, limit, order }, options)).data;
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  };
  const [users, compactions, assistants] = await Promise.all([
    read("user", SCAN_USER_LIMIT, "asc"),
    read("compaction", SCAN_COMPACTION_LIMIT, "desc"),
    read("assistant", SCAN_ASSISTANT_LIMIT, "desc"),
  ]);
  // Chronological order: prompts, then compaction summaries, then the latest assistant steps.
  const raw = [...users, ...compactions.reverse(), ...assistants.reverse()];
  return { messages: normalizeMessages(raw, DEFAULT_FILTER_LIMITS), failures };
}

function isAbort(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Find sessions of one project. Without a query: the most recent sessions. With a query:
 * title matches from the server (`search` covers titles only) plus an in-bridge search of the
 * filtered message text of the `scan` most recent sessions. GET requests only; a time budget
 * turns a slow scan into a partial result instead of an error.
 */
export async function searchSessions(
  client: SessionSearchClient,
  options: SearchOptions,
): Promise<SearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs ?? 15_000);
  const { signal } = controller;
  const query = options.query?.trim() ?? "";

  try {
    if (!query) {
      const recent = await pageSessions(
        client,
        { project: options.project },
        { want: options.limit, signal },
      );
      return { sessions: recent.map((session) => toHit(session)), scanned: 0, partial: false };
    }

    const [titleSessions, recent] = await Promise.all([
      pageSessions(
        client,
        { project: options.project, search: query },
        { want: options.limit, signal },
      ),
      pageSessions(client, { project: options.project }, { want: options.scan, signal }),
    ]);
    const titleIds = new Set(titleSessions.map((session) => session.id));
    const candidates = recent.slice(0, options.scan).filter((session) => !titleIds.has(session.id));

    const contentHits: Array<SessionHit | null> = new Array(candidates.length).fill(null);
    let found = titleSessions.length;
    let next = 0;
    let finished = 0;
    let errors = 0;
    let firstError: string | undefined;

    const worker = async (): Promise<void> => {
      while (!isAbort(signal) && found < options.limit) {
        const index = next++;
        const session = candidates[index];
        if (!session) return;
        try {
          const { messages, failures } = await fetchSessionText(client, session.id, signal);
          if (failures.length === 3) {
            errors += 1;
            firstError ??= failures[0];
          }
          finished += 1;
          const match = findContentMatch(messages, query, {
            ...(options.snippetChars ? { snippetChars: options.snippetChars } : {}),
          });
          if (match) {
            contentHits[index] = toHit(session, {
              match: "content",
              snippet: match.snippet,
              message_ids: match.messageIds,
            });
            found += 1;
          }
        } catch (error) {
          if (isAbort(signal)) return;
          errors += 1;
          firstError ??= error instanceof Error ? error.message : String(error);
          finished += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));

    const sessions = [
      ...titleSessions.map((session) => toHit(session, { match: "title" })),
      ...contentHits.filter((hit): hit is SessionHit => hit !== null),
    ].slice(0, options.limit);
    const enough = found >= options.limit;

    return {
      sessions,
      scanned: finished,
      partial: !enough && finished < candidates.length,
      ...(errors > 0
        ? { scan_errors: errors, ...(firstError ? { scan_error: firstError } : {}) }
        : {}),
    };
  } catch (error) {
    if (!isAbort(signal)) throw error;
    // The budget ran out while listing: nothing usable was collected.
    return { sessions: [], scanned: 0, partial: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface BudgetedPayload {
  sessions: SessionHit[];
  [key: string]: unknown;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * Keep a find_sessions answer under `maxChars` of compact JSON: shorten snippets first, then
 * trim message ids, then drop the oldest hits (reported as `omitted`).
 */
export function fitToBudget<T extends BudgetedPayload>(payload: T, maxChars = 4_000): T {
  const size = (value: unknown): number => JSON.stringify(value).length;
  if (size(payload) <= maxChars) return payload;

  let current: T = { ...payload, truncated: true };
  const reshape = (snippetMax: number, idMax: number): T => ({
    ...current,
    sessions: current.sessions.map((hit) => ({
      ...hit,
      ...(hit.snippet ? { snippet: cut(hit.snippet, snippetMax) } : {}),
      ...(hit.message_ids ? { message_ids: hit.message_ids.slice(0, idMax) } : {}),
    })),
  });

  for (const [snippetMax, idMax] of [
    [120, 5],
    [60, 3],
    [40, 2],
  ] as const) {
    current = reshape(snippetMax, idMax);
    if (size(current) <= maxChars) return current;
  }

  const sessions = [...current.sessions];
  while (sessions.length > 0) {
    const omitted = payload.sessions.length - sessions.length;
    if (size({ ...current, sessions, omitted }) <= maxChars) break;
    sessions.pop();
  }
  return { ...current, sessions, omitted: payload.sessions.length - sessions.length };
}
