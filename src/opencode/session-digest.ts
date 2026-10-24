import type { MessagePage, SessionInfo } from "./api-types.js";
import { normalizePathKey } from "./project-resolver.js";
import { describeError, extractChangedFiles, normalizeMessage } from "./session-filter.js";

/**
 * session_digest: a hard-capped (about 1500 characters) summary of one session, built from a
 * handful of GET requests. The pure parts (`lightMessage`, `buildDigest`, `fitDigest`) have no
 * I/O; `digestSession` does the reading.
 *
 * Source of each field (live facts about OpenCode 2.0.x):
 * - goal / last_request: `message?type=user&limit=1` (asc / desc);
 * - compaction_summary: `message?type=compaction&order=desc&limit=1`;
 * - final_state: `message?type=idle&order=desc&limit=1` (idle.outcome, idle.error);
 * - fingerprint: `message?order=desc&limit=1`;
 * - files, errors, tools, counts: one paged pass over all messages, keeping only light records
 *   (`order` goes on the first request only: with a cursor the API answers 400).
 * Changed files come from the write/edit tool INPUT paths: /diff is empty outside git folders.
 */

export const DIGEST_MAX_CHARS = 1_500;
export const DIGEST_BUDGET_MS = 15_000;
export const DIGEST_PAGE_SIZE = 100;
export const DIGEST_MAX_PAGES = 30;

/** The read-only slice of OpenCodeClient that the digest needs. */
export interface DigestClient {
  getSession(sessionId: string): Promise<SessionInfo>;
  messages(
    sessionId: string,
    query: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string },
    options?: { signal?: AbortSignal },
  ): Promise<MessagePage>;
}

export interface DigestError {
  /** The message to read for context: the assistant message when there is one. */
  msg_id: string;
  /** The idle message that reported the same error, when it is a different message. */
  idle_msg_id?: string;
  type: string;
  status?: number;
  message: string;
}

export interface SessionDigest {
  title: string;
  goal?: string;
  last_request?: string;
  compaction_summary?: string;
  files_changed: string[];
  /** Set when more files changed than are listed. */
  files_total?: number;
  errors: DigestError[];
  final_state: {
    outcome: string;
    finish?: string;
    idle_error?: { type?: string; message: string };
  };
  tools_used: Record<string, number>;
  counts: { messages: number; user: number; assistant: number };
  /** Last message id, its time (epoch ms) and the outcome: changes whenever the session does. */
  fingerprint: string;
  /** Some data is missing: the scan ran out of time/pages or a request failed. */
  partial?: true;
  /** Fields were shortened to stay under the size cap. */
  truncated?: true;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whitespace collapsed, cut to `max` characters (the ellipsis counts). */
export function cutText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Keep the tail of a path (the file name matters most). */
function cutPath(path: string, max: number): string {
  return path.length > max ? `…${path.slice(path.length - (max - 1))}` : path;
}

// ---- light records -------------------------------------------------------

/** What the scan keeps of one message: ids, names and short error texts, never content. */
export interface LightMessage {
  id: string;
  type: string;
  at?: number;
  finish?: string;
  tools: string[];
  files: string[];
  errors: Array<{ type: string; status?: number; message: string }>;
}

const WIDE = { errorChars: 2_000 };

export function lightMessage(raw: unknown): LightMessage | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const type = str(raw.type);
  if (!id || !type) return null;
  const time = isRec(raw.time) ? raw.time : undefined;
  const light: LightMessage = {
    id,
    type,
    ...(typeof time?.created === "number" ? { at: time.created } : {}),
    tools: [],
    files: extractChangedFiles([raw]),
    errors: [],
  };

  if (type === "assistant") {
    for (const item of Array.isArray(raw.content) ? raw.content : []) {
      if (!isRec(item) || item.type !== "tool") continue;
      const name = str(item.name);
      if (!name) continue;
      light.tools.push(name);
      const state = isRec(item.state) ? item.state : {};
      if (state.status === "error") {
        const error = describeError(state.error, WIDE);
        light.errors.push({
          type: `tool:${name}`,
          ...(error?.status !== undefined ? { status: error.status } : {}),
          message: error?.message ?? "tool call failed",
        });
      }
    }
    const error = describeError(raw.error, WIDE);
    if (error) {
      light.errors.push({
        type: error.type ?? "error",
        ...(error.status !== undefined ? { status: error.status } : {}),
        message: error.message,
      });
    }
    const finish = str(raw.finish);
    if (finish) light.finish = finish;
    if (finish === "error" && light.errors.length === 0) {
      light.errors.push({ type: "finish_error", message: "assistant finished with an error" });
    }
  } else if (type === "idle") {
    const error = describeError(raw.error, WIDE);
    if (error) {
      light.errors.push({
        type: error.type ?? "idle_error",
        ...(error.status !== undefined ? { status: error.status } : {}),
        message: error.message,
      });
    }
  }
  return light;
}

// ---- building ------------------------------------------------------------

export interface DigestParts {
  session: Pick<SessionInfo, "title" | "outcome" | "location">;
  firstUser?: unknown;
  lastUser?: unknown;
  compaction?: unknown;
  idle?: unknown;
  last?: unknown;
  /** Chronological. */
  records: readonly LightMessage[];
  /** The scan reached the first message. */
  scanComplete: boolean;
  /** A request that should have answered failed. */
  gaps: boolean;
}

const NO_CLIP = {
  textChars: 1_000_000,
  summaryChars: 1_000_000,
  inputChars: 200,
  errorChars: 2_000,
};

function userText(raw: unknown): string | undefined {
  const message = normalizeMessage(raw, NO_CLIP);
  if (message?.type !== "user") return undefined;
  if (message.text) return message.text;
  return message.files?.length ? `[attachment: ${message.files.join(", ")}]` : undefined;
}

function summaryText(raw: unknown): string | undefined {
  const message = normalizeMessage(raw, NO_CLIP);
  return message?.type === "compaction" && message.summary ? message.summary : undefined;
}

/** Make absolute tool paths relative to the session folder (shorter, and still unambiguous). */
function relativize(path: string, directory: string | undefined): string {
  if (!directory) return path;
  const root = normalizePathKey(directory);
  const key = normalizePathKey(path);
  if (root.length > 1 && key.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

/** The full digest (caps per field only); `fitDigest` squeezes it under the total cap. */
export function buildDigest(parts: DigestParts): SessionDigest {
  const directory = parts.session.location?.directory;

  const toolCounts = new Map<string, number>();
  const files: string[] = [];
  const seenFiles = new Set<string>();
  let user = 0;
  let assistant = 0;
  let finish: string | undefined;
  for (const record of parts.records) {
    if (record.type === "user") user += 1;
    if (record.type === "assistant") {
      assistant += 1;
      if (record.finish) finish = record.finish;
    }
    for (const tool of record.tools) toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    for (const file of record.files) {
      const short = relativize(file, directory);
      if (!seenFiles.has(short)) {
        seenFiles.add(short);
        files.push(short);
      }
    }
  }

  // Newest first, one entry per distinct (type, message). When the assistant message and the
  // idle message report the same error, the entry points to the ASSISTANT message (that is where
  // the context is); the idle id is kept as `idle_msg_id`.
  const errors: DigestError[] = [];
  const seenErrors = new Map<string, { entry: DigestError; byIdle: boolean }>();
  for (const record of [...parts.records].reverse()) {
    const isIdle = record.type === "idle";
    for (const error of [...record.errors].reverse()) {
      const key = `${error.type}|${error.message}`;
      const seen = seenErrors.get(key);
      if (seen) {
        if (seen.byIdle && !isIdle) {
          seen.entry.idle_msg_id = seen.entry.msg_id;
          seen.entry.msg_id = record.id;
          seen.byIdle = false;
        } else if (!seen.byIdle && isIdle && !seen.entry.idle_msg_id) {
          seen.entry.idle_msg_id = record.id;
        }
        continue;
      }
      const entry: DigestError = {
        msg_id: record.id,
        type: error.type,
        ...(error.status !== undefined ? { status: error.status } : {}),
        message: cutText(error.message, 200),
      };
      seenErrors.set(key, { entry, byIdle: isIdle });
      errors.push(entry);
    }
  }

  const idle = normalizeMessage(parts.idle, NO_CLIP);
  const idleMessage = idle?.type === "idle" ? idle : undefined;
  const outcome = idleMessage?.outcome ?? parts.session.outcome ?? "unknown";
  const idleError = idleMessage?.error;

  const lastRaw = isRec(parts.last) ? parts.last : undefined;
  const lastId = str(lastRaw?.id);
  const lastTime = isRec(lastRaw?.time) ? lastRaw.time.created : undefined;
  const fingerprint = lastId
    ? `${lastId}@${typeof lastTime === "number" ? lastTime : 0}:${outcome}`
    : `empty:${outcome}`;

  const goal = userText(parts.firstUser);
  const lastRequest = userText(parts.lastUser);
  const summary = summaryText(parts.compaction);
  const sortedTools = [...toolCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  return {
    title: cutText(parts.session.title ?? "", 100),
    ...(goal ? { goal: cutText(goal, 300) } : {}),
    ...(lastRequest ? { last_request: cutText(lastRequest, 300) } : {}),
    ...(summary ? { compaction_summary: cutText(summary, 600) } : {}),
    files_changed: files.slice(0, 20).map((file) => cutPath(file, 120)),
    ...(files.length > 20 ? { files_total: files.length } : {}),
    errors: errors.slice(0, 5),
    final_state: {
      outcome,
      ...(finish ? { finish } : {}),
      ...(idleError
        ? {
            idle_error: {
              ...(idleError.type ? { type: idleError.type } : {}),
              message: cutText(idleError.message, 200),
            },
          }
        : {}),
    },
    tools_used: Object.fromEntries(sortedTools.slice(0, 10)),
    counts: { messages: parts.records.length, user, assistant },
    fingerprint,
    ...(!parts.scanComplete || parts.gaps ? { partial: true as const } : {}),
  };
}

// ---- fitting -------------------------------------------------------------

interface Level {
  goal: number;
  last: number;
  summary: number;
  files: number;
  path: number;
  errors: number;
  errorMessage: number;
  tools: number;
  title: number;
}

/** From "as built" to very short; the first level that fits wins. */
const LEVELS: readonly Level[] = [
  {
    goal: 300,
    last: 300,
    summary: 600,
    files: 20,
    path: 120,
    errors: 5,
    errorMessage: 200,
    tools: 10,
    title: 100,
  },
  {
    goal: 200,
    last: 200,
    summary: 300,
    files: 12,
    path: 90,
    errors: 4,
    errorMessage: 140,
    tools: 8,
    title: 80,
  },
  {
    goal: 140,
    last: 140,
    summary: 160,
    files: 8,
    path: 70,
    errors: 3,
    errorMessage: 100,
    tools: 6,
    title: 60,
  },
  {
    goal: 100,
    last: 100,
    summary: 0,
    files: 4,
    path: 60,
    errors: 2,
    errorMessage: 80,
    tools: 4,
    title: 50,
  },
  {
    goal: 60,
    last: 60,
    summary: 0,
    files: 2,
    path: 50,
    errors: 1,
    errorMessage: 60,
    tools: 3,
    title: 40,
  },
];

function applyLevel(digest: SessionDigest, level: Level, truncated: boolean): SessionDigest {
  const { title, compaction_summary: summary, goal, last_request: last, ...rest } = digest;
  const files = digest.files_changed.slice(0, level.files).map((file) => cutPath(file, level.path));
  const total = digest.files_total ?? digest.files_changed.length;
  return {
    title: cutText(title, level.title),
    ...(goal ? { goal: cutText(goal, level.goal) } : {}),
    ...(last ? { last_request: cutText(last, level.last) } : {}),
    ...(summary && level.summary > 0
      ? { compaction_summary: cutText(summary, level.summary) }
      : {}),
    ...rest,
    files_changed: files,
    ...(total > files.length ? { files_total: total } : {}),
    errors: digest.errors
      .slice(0, level.errors)
      .map((error) => ({ ...error, message: cutText(error.message, level.errorMessage) })),
    tools_used: Object.fromEntries(Object.entries(digest.tools_used).slice(0, level.tools)),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

function sizeOf(digest: SessionDigest): number {
  return JSON.stringify(digest).length;
}

/** Shorten fields step by step until the compact JSON is at most `maxChars` long. */
export function fitDigest(digest: SessionDigest, maxChars = DIGEST_MAX_CHARS): SessionDigest {
  if (sizeOf(digest) <= maxChars) return digest;
  let current = digest;
  for (const level of LEVELS) {
    current = applyLevel(digest, level, true);
    if (sizeOf(current) <= maxChars) return current;
  }
  // Last resort (an enormous title or id): keep only what identifies the session's state.
  const { files_total: _t, compaction_summary: _s, ...bare } = current;
  const lean: SessionDigest = {
    ...bare,
    title: cutText(current.title, 30),
    files_changed: [],
    errors: current.errors
      .slice(0, 1)
      .map((error) => ({ ...error, message: cutText(error.message, 40) })),
    tools_used: {},
  };
  return lean;
}

// ---- reading -------------------------------------------------------------

async function firstMessage(
  client: DigestClient,
  sessionId: string,
  query: { type?: string; order: "asc" | "desc" },
  signal: AbortSignal,
): Promise<{ raw?: unknown; failed: boolean }> {
  try {
    const page = await client.messages(sessionId, { ...query, limit: 1 }, { signal });
    return { raw: page.data[0], failed: false };
  } catch {
    return { failed: true };
  }
}

/** One paged pass, newest first, keeping light records only. Returns them chronologically. */
async function scanMessages(
  client: DigestClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ records: LightMessage[]; complete: boolean; failed: boolean }> {
  const newestFirst: LightMessage[] = [];
  let cursor: string | undefined;
  let complete = false;
  let failed = false;
  try {
    for (let page = 0; page < DIGEST_MAX_PAGES && !signal.aborted; page += 1) {
      const result = await client.messages(
        sessionId,
        { limit: DIGEST_PAGE_SIZE, ...(cursor ? { cursor } : { order: "desc" as const }) },
        { signal },
      );
      for (const raw of result.data) {
        const light = lightMessage(raw);
        if (light) newestFirst.push(light);
      }
      cursor = result.cursor?.next;
      if (result.data.length < DIGEST_PAGE_SIZE || !cursor) {
        complete = true;
        break;
      }
    }
  } catch {
    // Out of time or a failed page: keep what was read and report the digest as partial.
    failed = !signal.aborted;
  }
  return { records: newestFirst.reverse(), complete, failed };
}

/**
 * Read one session (GET only) and build its digest. A missing session throws the client's
 * 404; a failed side request only makes the digest `partial`.
 */
export async function digestSession(
  client: DigestClient,
  sessionId: string,
  options: { budgetMs?: number; maxChars?: number } = {},
): Promise<SessionDigest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs ?? DIGEST_BUDGET_MS);
  const { signal } = controller;
  try {
    const [session, firstUser, lastUser, compaction, idle, last, scan] = await Promise.all([
      client.getSession(sessionId),
      firstMessage(client, sessionId, { type: "user", order: "asc" }, signal),
      firstMessage(client, sessionId, { type: "user", order: "desc" }, signal),
      firstMessage(client, sessionId, { type: "compaction", order: "desc" }, signal),
      firstMessage(client, sessionId, { type: "idle", order: "desc" }, signal),
      firstMessage(client, sessionId, { order: "desc" }, signal),
      scanMessages(client, sessionId, signal),
    ]);
    const gaps = [firstUser, lastUser, compaction, idle, last].some((part) => part.failed);
    const digest = buildDigest({
      session,
      firstUser: firstUser.raw,
      lastUser: lastUser.raw,
      compaction: compaction.raw,
      idle: idle.raw,
      last: last.raw,
      records: scan.records,
      scanComplete: scan.complete,
      gaps: gaps || scan.failed,
    });
    return fitDigest(digest, options.maxChars ?? DIGEST_MAX_CHARS);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
