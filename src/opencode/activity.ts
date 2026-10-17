import type { AssistantContent, SessionMessage } from "./api-types.js";

export interface SessionActivity {
  /** Epoch ms of the newest timestamp found in the recent messages. */
  at: number;
  /** Short description of the newest step, e.g. "tool write (completed)". */
  summary: string;
}

function latest(time: unknown): number {
  if (!time || typeof time !== "object") return 0;
  let max = 0;
  for (const value of Object.values(time)) {
    if (typeof value === "number" && value > max) max = value;
  }
  return max;
}

function describeContent(item: AssistantContent): string {
  if (item.type === "tool") {
    const status = (item as { state?: { status?: string } }).state?.status;
    const name = (item as { name?: string }).name ?? "tool";
    return `tool ${name}${status ? ` (${status})` : ""}`;
  }
  if (item.type === "reasoning") return "reasoning";
  if (item.type === "text") return "writing response";
  return item.type;
}

/**
 * Newest activity visible in a window of recent session messages: the maximum
 * of every message and content-part timestamp, plus a description of the part
 * that carries it. Returns null when no timestamps are present.
 */
export function latestActivity(messages: SessionMessage[]): SessionActivity | null {
  let best: SessionActivity | null = null;
  const consider = (at: number, summary: string): void => {
    if (at > 0 && (!best || at >= best.at)) best = { at, summary };
  };
  for (const message of messages) {
    if (message.type === "assistant") {
      const content = (message as { content?: AssistantContent[] }).content ?? [];
      consider(latest(message.time), "assistant message");
      for (const item of content) {
        consider(latest((item as { time?: unknown }).time), describeContent(item));
      }
    } else {
      consider(latest(message.time), message.type === "idle" ? "run finished" : "user prompt");
    }
  }
  return best;
}
