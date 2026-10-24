/**
 * Pure helpers (no I/O) that reduce raw OpenCode session messages to a compact form.
 *
 * A real session is ~2% conversation: tool output is ~53%, reasoning ~18%, tool input ~10%
 * (a `write` input is the whole file) and metadata ~15%. Everything the bridge shows to
 * Claude or searches goes through this filter, which KEEPS user text, assistant text,
 * compaction summaries, errors and one-line tool calls, and DROPS reasoning, base64 file
 * data, tool output and system prompts.
 */

export interface FilterLimits {
  /** Per user/assistant text field. */
  textChars: number;
  /** Per compaction summary. */
  summaryChars: number;
  /** Per tool-input summary and shell command. */
  inputChars: number;
  /** Per error message. */
  errorChars: number;
}

export const DEFAULT_FILTER_LIMITS: FilterLimits = {
  textChars: 2_000,
  summaryChars: 1_500,
  inputChars: 200,
  errorChars: 300,
};

export interface CompactError {
  type?: string;
  status?: number;
  message: string;
}

export interface CompactTool {
  name: string;
  status: string;
  /** Path or command only, one line. */
  input?: string;
  error?: string;
}

export type CompactMessage =
  | { id: string; type: "user"; at?: number; text: string; files?: string[] }
  | {
      id: string;
      type: "assistant";
      at?: number;
      agent?: string;
      finish?: string;
      text?: string;
      tools?: CompactTool[];
      error?: CompactError;
    }
  | { id: string; type: "compaction"; at?: number; summary: string; failed?: boolean }
  | {
      id: string;
      type: "shell";
      at?: number;
      command: string;
      status: string;
      exit?: number | string;
    }
  | { id: string; type: "idle"; at?: number; outcome: string; error?: CompactError };

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Cut `text` to `maxChars` and say how much was dropped. */
export function clip(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} [truncated ${text.length - maxChars} chars]`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Short cut for values shown on one line (the clip marker keeps the size visible). */
function clipLine(text: string, maxChars: number): string {
  return clip(collapse(text), maxChars);
}

/**
 * Reduce an error of any shape seen in the wild to {type, status, message}: the structured
 * form (`{type, message, status}`), the legacy form (`{name, data: {message}}`) or a string.
 */
export function describeError(
  raw: unknown,
  limits: Pick<FilterLimits, "errorChars"> = DEFAULT_FILTER_LIMITS,
): CompactError | undefined {
  if (typeof raw === "string") {
    const message = collapse(raw);
    return message ? { message: clip(message, limits.errorChars) } : undefined;
  }
  if (!isRec(raw)) return undefined;
  const data = isRec(raw.data) ? raw.data : undefined;
  const type = str(raw.type) ?? str(raw.name);
  const message = str(raw.message) ?? str(data?.message) ?? type;
  if (!message) return undefined;
  const status = typeof raw.status === "number" ? raw.status : undefined;
  return {
    ...(type ? { type } : {}),
    ...(status !== undefined ? { status } : {}),
    message: clipLine(message, limits.errorChars),
  };
}

const PATH_KEYS = ["path", "filePath", "file_path", "filepath", "file", "filename"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const COMMAND_TOOLS = new Set(["shell", "execute", "bash"]);

/** One-line summary of a tool input: the path or the command, never file contents. */
export function summarizeToolInput(
  name: string,
  input: unknown,
  maxChars = DEFAULT_FILTER_LIMITS.inputChars,
): string | undefined {
  if (!isRec(input)) return undefined;
  const lower = name.toLowerCase();
  const keys = COMMAND_TOOLS.has(lower)
    ? [...COMMAND_KEYS, ...PATH_KEYS]
    : [...PATH_KEYS, ...COMMAND_KEYS];
  if (lower === "skill") keys.unshift("name");
  for (const key of keys) {
    const value = str(input[key]);
    if (value) return clipLine(value, maxChars);
  }
  return undefined;
}

function compactTool(item: Rec, limits: FilterLimits): CompactTool | null {
  const name = str(item.name);
  if (!name) return null;
  const state = isRec(item.state) ? item.state : {};
  const status = str(state.status) ?? "unknown";
  const input = summarizeToolInput(name, state.input, limits.inputChars);
  const error = status === "error" ? describeError(state.error, limits) : undefined;
  return {
    name,
    status,
    ...(input ? { input } : {}),
    ...(error ? { error: error.type ? `${error.type}: ${error.message}` : error.message } : {}),
  };
}

function atOf(message: Rec): number | undefined {
  const time = isRec(message.time) ? message.time : undefined;
  return typeof time?.created === "number" ? time.created : undefined;
}

/**
 * Normalize one raw message. Returns null for messages that carry nothing worth showing
 * (system prompts, synthetic/skill/agent-switch markers, running compactions).
 */
export function normalizeMessage(
  raw: unknown,
  limits: FilterLimits = DEFAULT_FILTER_LIMITS,
): CompactMessage | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const type = str(raw.type);
  if (!id || !type) return null;
  const at = atOf(raw);
  const base = { id, ...(at !== undefined ? { at } : {}) };

  switch (type) {
    case "user": {
      const text = str(raw.text) ?? "";
      const files = Array.isArray(raw.files)
        ? raw.files
            .filter(isRec)
            // Names only: `data` is the base64 payload.
            .map((file) => str(file.name) ?? str(file.mime))
            .filter((name): name is string => name !== undefined)
            .slice(0, 5)
        : [];
      if (!text && files.length === 0) return null;
      return {
        ...base,
        type: "user",
        text: clip(text, limits.textChars),
        ...(files.length > 0 ? { files } : {}),
      };
    }

    case "assistant": {
      const content = Array.isArray(raw.content) ? raw.content : [];
      const texts: string[] = [];
      const tools: CompactTool[] = [];
      for (const item of content) {
        if (!isRec(item)) continue;
        if (item.type === "text") {
          const text = str(item.text);
          if (text) texts.push(text);
        } else if (item.type === "tool") {
          const tool = compactTool(item, limits);
          if (tool) tools.push(tool);
        }
        // `reasoning` and unknown content types are dropped.
      }
      const error = describeError(raw.error, limits);
      const text = texts.join("\n\n");
      const agent = str(raw.agent);
      const finish = str(raw.finish);
      return {
        ...base,
        type: "assistant",
        ...(agent ? { agent } : {}),
        ...(finish ? { finish } : {}),
        ...(text ? { text: clip(text, limits.textChars) } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(error ? { error } : {}),
      };
    }

    case "compaction": {
      const summary = str(raw.summary);
      if (raw.status === "failed") {
        return { ...base, type: "compaction", summary: summary ?? "", failed: true };
      }
      if (!summary) return null;
      return { ...base, type: "compaction", summary: clip(summary, limits.summaryChars) };
    }

    case "shell": {
      const command = str(raw.command);
      if (!command) return null;
      const exit =
        typeof raw.exit === "number" || typeof raw.exit === "string" ? raw.exit : undefined;
      return {
        ...base,
        type: "shell",
        command: clipLine(command, limits.inputChars),
        status: str(raw.status) ?? "unknown",
        ...(exit !== undefined ? { exit } : {}),
      };
    }

    case "idle": {
      const error = describeError(raw.error, limits);
      return {
        ...base,
        type: "idle",
        outcome: str(raw.outcome) ?? "unknown",
        ...(error ? { error } : {}),
      };
    }

    default:
      return null;
  }
}

export function normalizeMessages(
  raw: readonly unknown[],
  limits: FilterLimits = DEFAULT_FILTER_LIMITS,
): CompactMessage[] {
  const out: CompactMessage[] = [];
  for (const message of raw) {
    const compact = normalizeMessage(message, limits);
    if (compact) out.push(compact);
  }
  return out;
}

const EDIT_TOOLS = new Set(["write", "edit"]);

/**
 * Files touched by `write` / `edit` tool calls, in order of first appearance, de-duplicated.
 * Calls that ended in an error changed nothing and are skipped. Uses the tool INPUT path only.
 */
export function extractChangedFiles(messages: readonly unknown[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!isRec(message) || message.type !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const item of message.content) {
      if (!isRec(item) || item.type !== "tool") continue;
      const name = str(item.name)?.toLowerCase();
      if (!name || !EDIT_TOOLS.has(name)) continue;
      const state = isRec(item.state) ? item.state : {};
      if (state.status === "error") continue;
      const input = isRec(state.input) ? state.input : undefined;
      if (!input) continue;
      const file = PATH_KEYS.map((key) => str(input[key])).find((value) => value !== undefined);
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/** The text of a compact message that content search looks at. */
export function searchableText(message: CompactMessage): string {
  switch (message.type) {
    case "user":
      return [message.text, ...(message.files ?? [])].join(" ");
    case "assistant":
      return [
        message.text ?? "",
        ...(message.tools ?? []).map((tool) =>
          [tool.name, tool.input ?? "", tool.error ?? ""].join(" "),
        ),
        message.error?.message ?? "",
      ].join(" ");
    case "compaction":
      return message.summary;
    case "shell":
      return message.command;
    case "idle":
      return message.error?.message ?? "";
  }
}

export interface ContentMatch {
  /** Up to `maxIds` ids of the matching messages, in input order. */
  messageIds: string[];
  /** Whitespace-collapsed excerpt around the first hit, at most `snippetChars` long. */
  snippet: string;
}

function queryTerms(query: string): string[] {
  return collapse(query.toLowerCase())
    .split(" ")
    .filter((term) => term.length > 0);
}

function excerpt(text: string, term: string, maxChars: number): string {
  const flat = collapse(text);
  if (flat.length <= maxChars) return flat;
  const index = Math.max(0, flat.toLowerCase().indexOf(term));
  const lead = Math.min(index, 60);
  let start = index - lead;
  let end = start + maxChars;
  if (end > flat.length) {
    end = flat.length;
    start = Math.max(0, end - maxChars);
  }
  // Reserve room for the ellipses so the total never exceeds maxChars.
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const room = maxChars - prefix.length - suffix.length;
  return `${prefix}${flat.slice(start, start + room)}${suffix}`;
}

/**
 * Case-insensitive content search over already-filtered messages. A message matches when it
 * contains every whitespace-separated term of `query`. Returns null when nothing matches.
 */
export function findContentMatch(
  messages: readonly CompactMessage[],
  query: string,
  options: { snippetChars?: number; maxIds?: number } = {},
): ContentMatch | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const snippetChars = options.snippetChars ?? 200;
  const maxIds = options.maxIds ?? 5;

  const ids: string[] = [];
  let snippet: string | null = null;
  for (const message of messages) {
    const text = searchableText(message);
    const lower = text.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    if (snippet === null) snippet = excerpt(text, terms[0] ?? "", snippetChars);
    if (ids.length < maxIds) ids.push(message.id);
  }
  return snippet === null ? null : { messageIds: ids, snippet };
}
