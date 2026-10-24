import type { MessagePage, SessionMessage } from "./api-types.js";
import {
  type CompactMessage,
  type CompactTool,
  type FilterLimits,
  normalizeMessage,
} from "./session-filter.js";

/**
 * read_messages: a few messages of one session in a compact, budgeted form.
 *
 * Reads go through the shared session filter (the same one find_sessions searches through), so
 * reasoning, base64 attachments, raw tool output and the content of write/edit calls never
 * reach the answer: tools are shown as name, status and a one-line input summary (path or
 * command). The answer as a whole stays under `maxChars`; what does not fit is reported with
 * `more: true` instead of being squeezed in.
 */

export const READ_MAX_CHARS = 6_000;
/** Default cap of the text of ONE message, so that several messages fit in one answer. */
export const READ_PER_MESSAGE_CHARS = 1_200;
export const READ_BUDGET_MS = 15_000;
export const READ_PAGE_SIZE = 100;
export const READ_MAX_PAGES = 20;
export const READ_MAX_IDS = 20;

/**
 * Limits of the shared filter for one read: texts and compaction summaries are cut to
 * `perMessageChars` and keep the "[truncated N chars]" marker; the character budget of the whole
 * answer is applied afterwards.
 */
export function readLimits(perMessageChars: number = READ_PER_MESSAGE_CHARS): FilterLimits {
  return {
    textChars: perMessageChars,
    summaryChars: perMessageChars,
    inputChars: 200,
    errorChars: 300,
  };
}

/** The read-only slice of OpenCodeClient that read_messages needs. */
export interface MessageReaderClient {
  message(
    sessionId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionMessage | null>;
  messages(
    sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string },
    options?: { signal?: AbortSignal },
  ): Promise<MessagePage>;
}

export interface ToolView {
  name: string;
  status: string;
  input_summary?: string;
  error?: string;
}

export interface MessageView {
  id: string;
  type: string;
  time?: string;
  text?: string;
  tools?: ToolView[];
  /** Tools beyond the ones listed (shortened to fit). */
  tools_omitted?: number;
  error?: { type?: string; status?: number; message: string };
  finish?: string;
  note?: string;
  truncated: boolean;
}

export interface ReadResult {
  messages: MessageView[];
  /** More was requested than the budget allowed. */
  more?: true;
  /** Requested ids that were not read (explicit mode, budget). */
  remaining_ids?: string[];
  /** Requested ids that do not exist in this session. */
  missing_ids?: string[];
  /** `around`: the message was not found (or the scan ran out of pages/time). */
  not_found?: string;
}

const MARKER = /\[truncated \d+ chars\]$/;

function iso(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : undefined;
}

function toolView(tool: CompactTool): ToolView {
  return {
    name: tool.name,
    status: tool.status,
    ...(tool.input ? { input_summary: tool.input } : {}),
    ...(tool.error ? { error: tool.error } : {}),
  };
}

/** One filtered message as shown to the caller. */
export function viewOf(message: CompactMessage): MessageView {
  const base = {
    id: message.id,
    type: message.type,
    ...(iso(message.at) ? { time: iso(message.at) } : {}),
  };
  switch (message.type) {
    case "user": {
      const text = [
        message.text,
        ...(message.files?.length ? [`[files: ${message.files.join(", ")}]`] : []),
      ]
        .filter(Boolean)
        .join("\n");
      return { ...base, text, truncated: MARKER.test(message.text) };
    }
    case "assistant":
      return {
        ...base,
        ...(message.text ? { text: message.text } : {}),
        ...(message.tools ? { tools: message.tools.map(toolView) } : {}),
        ...(message.error ? { error: message.error } : {}),
        ...(message.finish ? { finish: message.finish } : {}),
        truncated: message.text ? MARKER.test(message.text) : false,
      };
    case "compaction":
      return {
        ...base,
        text: message.failed ? "(compaction failed)" : message.summary,
        truncated: MARKER.test(message.summary),
      };
    case "shell":
      return {
        ...base,
        text: `$ ${message.command} (${message.status}${message.exit !== undefined ? `, exit ${message.exit}` : ""})`,
        truncated: false,
      };
    case "idle":
      return {
        ...base,
        text: `session idle: ${message.outcome}`,
        ...(message.error ? { error: message.error } : {}),
        truncated: false,
      };
  }
}

/** A message that has nothing worth showing (system prompt, synthetic marker, ...). */
function stubOf(raw: SessionMessage): MessageView {
  const time = (raw as { time?: { created?: number } }).time?.created;
  return {
    id: raw.id,
    type: raw.type,
    ...(iso(time) ? { time: iso(time) } : {}),
    note: "no readable content",
    truncated: false,
  };
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Shorten one view so that it takes at most `room` characters of JSON; null when even the
 * shortest form does not fit. Order: fewer tools first, then shorter text.
 */
export function shrinkView(view: MessageView, room: number): MessageView | null {
  if (sizeOf(view) <= room) return view;
  let current: MessageView = { ...view };
  if (current.tools && current.tools.length > 3) {
    current = {
      ...current,
      tools: current.tools.slice(0, 3),
      tools_omitted: current.tools.length - 3,
      truncated: true,
    };
    if (sizeOf(current) <= room) return current;
  }
  if (current.text) {
    const overflow = sizeOf(current) - room;
    // Cutting a JSON string can grow it (escapes), so leave a little slack.
    const keep = current.text.length - overflow - 8;
    if (keep >= 40) {
      const cut = { ...current, text: `${current.text.slice(0, keep)}…`, truncated: true };
      if (sizeOf(cut) <= room) return cut;
      return { ...cut, text: `${current.text.slice(0, Math.max(0, keep - 20))}…` };
    }
    const bare: MessageView = { ...current, text: "…", truncated: true };
    delete bare.tools;
    if (sizeOf(bare) <= room) return bare;
  }
  return null;
}

/** Fill the budget with views in the given priority order; the rest is reported as dropped. */
export function takeWithinBudget(
  views: readonly MessageView[],
  budget: number,
): { kept: MessageView[]; dropped: MessageView[]; shrunk: boolean } {
  const kept: MessageView[] = [];
  let used = 0;
  for (const [index, view] of views.entries()) {
    const room = budget - used - (kept.length > 0 ? 1 : 0);
    const fitted = shrinkView(view, room);
    if (!fitted) return { kept, dropped: views.slice(index), shrunk: false };
    kept.push(fitted);
    used += sizeOf(fitted) + (kept.length > 1 ? 1 : 0);
    // A shortened message means the budget is gone: later ones would be squeezed out anyway.
    if (fitted !== view) return { kept, dropped: views.slice(index + 1), shrunk: true };
  }
  return { kept, dropped: [], shrunk: false };
}

// ---- explicit ids --------------------------------------------------------

export async function readByIds(
  client: MessageReaderClient,
  sessionId: string,
  ids: readonly string[],
  signal?: AbortSignal,
  limits: FilterLimits = readLimits(),
): Promise<{ views: MessageView[]; missing: string[] }> {
  const unique = [...new Set(ids)];
  const options = signal ? { signal } : {};
  const raws = new Array<SessionMessage | null>(unique.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const index = next++;
      raws[index] = await client.message(sessionId, unique[index] as string, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));

  const views: MessageView[] = [];
  const missing: string[] = [];
  for (const [index, raw] of raws.entries()) {
    if (!raw) {
      missing.push(unique[index] as string);
      continue;
    }
    const compact = normalizeMessage(raw, limits);
    views.push(compact ? viewOf(compact) : stubOf(raw));
  }
  return { views, missing };
}

// ---- around one id -------------------------------------------------------

interface Entry {
  id: string;
  view: MessageView | null;
  /** Shown when this entry is the requested message but has no readable content. */
  stub: MessageView;
}

export interface AroundResult {
  /** Oldest first: the readable neighbours before, the message itself, the neighbours after. */
  views: MessageView[];
  /** Position of the requested message in `views`. */
  targetIndex: number;
}

interface Window {
  /** Chronological and contiguous. */
  entries: Entry[];
  /** Cursor to continue in the page direction (forward for `head`, backward for `tail`). */
  next: string | undefined;
  /** The last page was full: more may follow. */
  more: boolean;
}

/**
 * One page of messages as entries, oldest first. The first request of a walk passes `order`
 * (and no cursor); later requests pass the cursor only: the API answers 400 when both are
 * sent. `reverse` is true for a newest-first walk, whose pages arrive newest first. The end of
 * paging is a page with fewer items than `limit` (`cursor.next` is always returned).
 */
async function loadPage(
  client: MessageReaderClient,
  sessionId: string,
  query: { order?: "asc" | "desc"; cursor?: string },
  reverse: boolean,
  signal: AbortSignal,
  limits: FilterLimits = readLimits(),
): Promise<{ entries: Entry[]; next: string | undefined; more: boolean }> {
  const page = await client.messages(
    sessionId,
    {
      limit: READ_PAGE_SIZE,
      ...(query.cursor ? { cursor: query.cursor } : { order: query.order ?? "asc" }),
    },
    { signal },
  );
  const entries = page.data.map((raw): Entry => {
    const compact = normalizeMessage(raw, limits);
    return { id: raw.id, view: compact ? viewOf(compact) : null, stub: stubOf(raw) };
  });
  if (reverse) entries.reverse();
  const next = page.cursor?.next;
  return { entries, next, more: page.data.length >= READ_PAGE_SIZE && Boolean(next) };
}

function readable(entries: readonly Entry[], from: number, step: 1 | -1, want: number): number {
  let count = 0;
  for (let index = from; index >= 0 && index < entries.length; index += step) {
    if (entries[index]?.view) count += 1;
    if (count >= want) break;
  }
  return count;
}

/**
 * Find `target` without a by-id-with-neighbours endpoint: page from the start; when the first
 * page does not hold it, look at the newest page, then keep paging forward from the start.
 * Returns the target with up to `before` / `after` readable neighbours, oldest first.
 */
export async function readAround(
  client: MessageReaderClient,
  sessionId: string,
  target: string,
  before: number,
  after: number,
  signal: AbortSignal,
  limits: FilterLimits = readLimits(),
): Promise<AroundResult | { notFound: string }> {
  const find = (entries: readonly Entry[]): number =>
    entries.findIndex((entry) => entry.id === target);
  const pick = (entries: readonly Entry[], index: number): AroundResult => {
    const out: MessageView[] = [];
    let left = before;
    for (let i = index - 1; i >= 0 && left > 0; i -= 1) {
      const view = entries[i]?.view;
      if (view) {
        out.unshift(view);
        left -= 1;
      }
    }
    const targetIndex = out.length;
    const hit = entries[index];
    if (hit) out.push(hit.view ?? hit.stub);
    let right = after;
    for (let i = index + 1; i < entries.length && right > 0; i += 1) {
      const view = entries[i]?.view;
      if (view) {
        out.push(view);
        right -= 1;
      }
    }
    return { views: out, targetIndex };
  };

  // Head: pages from the oldest message, forward.
  const first = await loadPage(client, sessionId, { order: "asc" }, false, signal, limits);
  const head: Window = { entries: first.entries, next: first.next, more: first.more };
  const extendForward = async (): Promise<void> => {
    const page = await loadPage(
      client,
      sessionId,
      { cursor: head.next as string },
      false,
      signal,
      limits,
    );
    head.entries.push(...page.entries);
    head.next = page.next;
    head.more = page.more;
  };
  const foundInHead = async (): Promise<AroundResult | null> => {
    const index = find(head.entries);
    if (index < 0) return null;
    // Neighbours after the target may sit on the next pages.
    for (
      let pages = 0;
      pages < READ_MAX_PAGES && head.more && readable(head.entries, index + 1, 1, after) < after;
      pages += 1
    ) {
      await extendForward();
    }
    return pick(head.entries, index);
  };

  const direct = await foundInHead();
  if (direct) return direct;
  if (!head.more) return { notFound: "message is not in this session" };

  // Tail: the newest page, for ids near the end of a long session.
  const newest = await loadPage(client, sessionId, { order: "desc" }, true, signal, limits);
  const tail: Window = { entries: newest.entries, next: newest.next, more: newest.more };
  if (find(tail.entries) >= 0) {
    // Neighbours before the target may sit on older pages: a desc cursor continues backwards.
    for (
      let pages = 0;
      pages < READ_MAX_PAGES &&
      tail.more &&
      readable(tail.entries, find(tail.entries) - 1, -1, before) < before;
      pages += 1
    ) {
      const older = await loadPage(
        client,
        sessionId,
        { cursor: tail.next as string },
        true,
        signal,
        limits,
      );
      tail.entries = [...older.entries, ...tail.entries];
      tail.next = older.next;
      tail.more = older.more;
      if (older.entries.length === 0) break;
    }
    return pick(tail.entries, find(tail.entries));
  }

  // Middle of a long session: continue forward from the first page.
  for (let pages = 1; pages < READ_MAX_PAGES && head.more; pages += 1) {
    if (signal.aborted) break;
    await extendForward();
    const hit = await foundInHead();
    if (hit) return hit;
  }
  return {
    notFound: head.more
      ? "scan limit reached before the message was found"
      : "message is not in this session",
  };
}

// ---- entry point ---------------------------------------------------------

export interface ReadRequest {
  sessionId: string;
  /** Explicit mode: these messages, in this order. */
  messageIds?: readonly string[];
  /** Neighbour mode: this message plus `before` / `after` readable neighbours. */
  around?: string;
  before?: number;
  after?: number;
  /** Budget for the whole answer (compact JSON). */
  maxChars?: number;
  /** Cap of the text of one message (default READ_PER_MESSAGE_CHARS). */
  perMessageChars?: number;
  budgetMs?: number;
}

export interface ReadAnswer extends ReadResult {
  session_id: string;
}

/**
 * Read messages of one session (GET only) and fit them into `maxChars`. Messages are taken in
 * priority order (explicit mode: as listed; around mode: the message, then those after it, then
 * those before it); what does not fit is dropped and reported (`more`, `remaining_ids`).
 */
export async function readMessages(
  client: MessageReaderClient,
  request: ReadRequest,
): Promise<ReadAnswer> {
  const maxChars = request.maxChars ?? READ_MAX_CHARS;
  const limits = readLimits(request.perMessageChars ?? READ_PER_MESSAGE_CHARS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.budgetMs ?? READ_BUDGET_MS);
  try {
    let chronological: MessageView[] = [];
    let priority: MessageView[] = [];
    let missing: string[] = [];
    let notFound: string | undefined;

    if (request.around) {
      const result = await readAround(
        client,
        request.sessionId,
        request.around,
        request.before ?? 1,
        request.after ?? 2,
        controller.signal,
        limits,
      );
      if ("notFound" in result) {
        notFound = result.notFound;
      } else {
        chronological = result.views;
        const target = result.views[result.targetIndex];
        priority = [
          ...(target ? [target] : []),
          ...result.views.slice(result.targetIndex + 1),
          ...result.views.slice(0, result.targetIndex).reverse(),
        ];
      }
    } else {
      const result = await readByIds(
        client,
        request.sessionId,
        (request.messageIds ?? []).slice(0, READ_MAX_IDS),
        controller.signal,
        limits,
      );
      chronological = result.views;
      priority = result.views;
      missing = result.missing;
    }

    const header = {
      session_id: request.sessionId,
      ...(missing.length > 0 ? { missing_ids: missing } : {}),
      ...(notFound ? { not_found: notFound } : {}),
    };
    // Room for the wrapper, including `more`. The remaining_ids list is added to the reserve
    // when a first pass shows that it would not fit (a shortened last message fills the budget).
    const reserve = sizeOf({ ...header, messages: [], more: true });
    const order = new Map(chronological.map((view, index) => [view.id, index]));
    const assemble = (idsRoom: number): { answer: ReadAnswer; dropped: string[] } => {
      const { kept, dropped, shrunk } = takeWithinBudget(
        priority,
        Math.max(0, maxChars - reserve - idsRoom),
      );
      kept.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const more = dropped.length > 0 || shrunk;
      const droppedIds = dropped.map((view) => view.id);
      return {
        dropped: droppedIds,
        answer: {
          ...header,
          messages: kept,
          ...(more ? { more: true as const } : {}),
          ...(droppedIds.length > 0 ? { remaining_ids: droppedIds } : {}),
        },
      };
    };

    let idsRoom = 0;
    let result = assemble(idsRoom);
    for (let pass = 0; pass < 2 && sizeOf(result.answer) > maxChars; pass += 1) {
      idsRoom = sizeOf({ remaining_ids: result.dropped });
      result = assemble(idsRoom);
    }
    let { answer } = result;
    // The id list is a convenience: shrink it before anything else if the wrapper still ran over.
    let remaining = answer.remaining_ids ?? [];
    while (sizeOf(answer) > maxChars && remaining.length > 0) {
      remaining = remaining.slice(0, -1);
      const { remaining_ids: _dropped, ...rest } = answer;
      answer = { ...rest, ...(remaining.length > 0 ? { remaining_ids: remaining } : {}) };
    }
    return answer;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
