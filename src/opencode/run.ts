import type { ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import type { RunProgress, RunResult } from "../types/index.js";
import type { Logger } from "../util/logger.js";
import { extractFindings, stripAnsi } from "../util/text.js";
import type {
  AssistantMessage,
  IdleMessage,
  ModelRef,
  ServerEvent,
  SessionMessage,
} from "./api-types.js";
import type { OpenCodeClient } from "./client.js";

export type { ModelRef } from "./api-types.js";

/** Parse `provider/model` (or a bare model id) into a v2 model reference. */
export function parseModelRef(model: string, defaultProvider: string): ModelRef {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new BridgeError("INVALID_ARGUMENT", "model must not be empty");
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  return { providerID: defaultProvider, id: trimmed };
}

export function formatModelRef(ref: ModelRef | null): string | null {
  return ref ? `${ref.providerID}/${ref.id}` : null;
}

/**
 * Resolve which model a delegated run should use.
 *
 * Priority: explicit request > bridge configuration > the model catalog of the
 * running OpenCode (a model of `defaults.provider` when the server default is
 * of another provider) > the server's own default model.
 */
export async function resolveModel(
  client: Pick<OpenCodeClient, "defaultModel" | "models">,
  config: ResolvedConfig,
  requested?: string | null,
): Promise<ModelRef | null> {
  const raw = requested?.trim() ? requested.trim() : config.defaults.model;
  if (raw) return parseModelRef(raw, config.defaults.provider);

  let serverDefault: { id: string; providerID: string } | null = null;
  try {
    const model = await client.defaultModel();
    if (model?.id && model.providerID)
      serverDefault = { id: model.id, providerID: model.providerID };
  } catch {
    serverDefault = null;
  }
  if (serverDefault?.providerID === config.defaults.provider) {
    return { providerID: serverDefault.providerID, id: serverDefault.id };
  }

  try {
    const models = await client.models();
    const ofProvider = models.find((model) => model.providerID === config.defaults.provider);
    if (ofProvider) return { providerID: ofProvider.providerID, id: ofProvider.id };
  } catch {
    // fall through to the server default
  }

  if (serverDefault) return { providerID: serverDefault.providerID, id: serverDefault.id };
  throw new BridgeError(
    "MODEL_NOT_AVAILABLE",
    [
      `No default model is available for provider "${config.defaults.provider}".`,
      'Set `defaults.model` (for example "deepseek/deepseek-v4-pro") in the bridge config,',
      "or configure a default model in OpenCode, or pass `model` to delegate_task.",
    ].join(" "),
    { details: { provider: config.defaults.provider } },
  );
}

/** Text of an assistant message (reasoning and tool output excluded). */
export function assistantText(message: { content?: Array<{ type: string }> } | undefined): string {
  if (!message?.content) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => {
      return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
    })
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

interface RunErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Map an OpenCode error payload (named error object, `{message}` or string) to a bridge error. */
export function describeError(error: unknown): RunErrorInfo {
  if (typeof error === "string") {
    return { code: "AGENT_EXECUTION_FAILED", message: error };
  }
  const record = error as {
    name?: string;
    type?: string;
    message?: string;
    data?: Record<string, unknown>;
  } | null;
  const name = record?.name ?? record?.type ?? "UnknownError";
  const data = record?.data ?? (record?.message ? { message: record.message } : {});
  switch (name) {
    case "ProviderAuthError":
      return {
        code: "OPENCODE_ERROR",
        message: `Provider authentication failed for ${String(data.providerID ?? "provider")}: ${String(
          data.message ?? "unknown error",
        )}`,
        details: { providerID: data.providerID },
      };
    case "MessageAbortedError":
      return { code: "AGENT_ABORTED", message: "The delegated run was aborted." };
    case "MessageOutputLengthError":
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: "The model hit its output length limit before finishing.",
      };
    case "APIError":
    case "ApiError":
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: String(data.message ?? "The model provider returned an error."),
        details: {
          statusCode: data.statusCode,
          responseBody:
            typeof data.responseBody === "string" ? data.responseBody.slice(0, 2000) : undefined,
          isRetryable: data.isRetryable,
        },
      };
    case "NotFoundError":
    case "notFound":
      return {
        code: "OPENCODE_SESSION_NOT_FOUND",
        message: String(data.message ?? "The OpenCode session no longer exists."),
      };
    default:
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: String(data.message ?? "The delegated run failed."),
        details: { name },
      };
  }
}

export interface RunPromptInput {
  client: OpenCodeClient;
  sessionId: string;
  text: string;
  timeoutMs: number;
  onProgress?: (progress: RunProgress) => void | Promise<void>;
  signal?: AbortSignal;
  logger: Logger;
}

const POLL_INTERVAL_MS = 1000;
/** How long OpenCode may take to start executing an accepted prompt. */
const ACCEPTANCE_GRACE_MS = 20_000;
/** Consecutive failed polls before the server is considered gone. */
const MAX_POLL_FAILURES = 5;
/** Re-reads of the message list while waiting for the final `idle` message. */
const IDLE_MESSAGE_RETRIES = 5;

type RunOutcome =
  | { kind: "done" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "not-accepted" }
  | { kind: "unavailable"; message: string };

function isAssistant(message: SessionMessage): message is AssistantMessage {
  return message.type === "assistant";
}

function isIdle(message: SessionMessage): message is IdleMessage {
  return message.type === "idle";
}

function messagesAfter(messages: SessionMessage[], baselineId: string | null): SessionMessage[] {
  if (!baselineId) return messages;
  const index = messages.findIndex((message) => message.id === baselineId);
  if (index >= 0) return messages.slice(index + 1);
  // Ids are time-ordered; keep only newer ones when the baseline is out of the window.
  return messages.filter((message) => message.id > baselineId);
}

async function recentMessages(
  client: OpenCodeClient,
  sessionId: string,
): Promise<SessionMessage[]> {
  const page = await client.messages(sessionId, { limit: 40, order: "desc" });
  return [...page.data].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Short human description of what the agent is doing, from an SSE event. */
function describeActivity(event: ServerEvent): string | null {
  switch (event.type) {
    case "session.tool.called": {
      const name = (event.data.name ?? event.data.tool) as string | undefined;
      return name ? `running ${name}` : "running tool";
    }
    case "session.tool.input.started": {
      const name = (event.data.name ?? event.data.tool) as string | undefined;
      return name ? `preparing ${name}` : "preparing tool call";
    }
    case "session.reasoning.started":
    case "session.reasoning.delta":
      return "reasoning";
    case "session.text.started":
    case "session.text.delta":
      return "writing response";
    default:
      return null;
  }
}

/**
 * Run a prompt to completion on an OpenCode 2.x session.
 *
 * The prompt is queued with `POST /api/session/{id}/prompt` (asynchronous). The
 * end of the run is detected through three signals, whichever comes first:
 *  1. an SSE `session.execution.*` event other than `started` for this session;
 *  2. the session disappearing from `GET /api/session/active` after it ran;
 *  3. a final `{type:"idle", outcome}` message in the session history.
 * Polling (2, 3) keeps working if the event stream is unavailable.
 */
export async function runPrompt(input: RunPromptInput): Promise<RunResult> {
  const startedAt = Date.now();
  const { client, sessionId } = input;
  let abortedByCaller = false;
  let settled = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let resolveOutcome: ((outcome: RunOutcome) => void) | null = null;
  const streamAbort = new AbortController();

  let sawActivity = false;
  let activity: string | null = null;
  let pollFailures = 0;
  let baselineId: string | null = null;

  const interruptSession = async (): Promise<void> => {
    try {
      await client.interrupt(sessionId);
    } catch {
      // best effort
    }
  };

  const settle = (outcome: RunOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome?.(outcome);
  };

  const onSignalAbort = () => {
    abortedByCaller = true;
    void interruptSession();
    settle({ kind: "aborted" });
  };

  if (input.signal) {
    if (input.signal.aborted) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled before it started.");
    }
    input.signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  const emit = async (progress: RunProgress) => {
    if (!input.onProgress) return;
    try {
      await input.onProgress(progress);
    } catch {
      // progress reporting must never break the run
    }
  };

  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    streamAbort.abort();
    input.signal?.removeEventListener("abort", onSignalAbort);
  };

  // Subscribe to events before sending the prompt so nothing is missed. The
  // stream is an optimisation: failures fall back to polling.
  try {
    const events = await client.openEvents(streamAbort.signal);
    void (async () => {
      try {
        for await (const event of events) {
          if (event.data.sessionID !== sessionId) continue;
          if (event.type === "session.execution.started") {
            sawActivity = true;
            continue;
          }
          if (event.type.startsWith("session.execution.")) {
            settle({ kind: "done" });
            return;
          }
          const described = describeActivity(event);
          if (described) {
            sawActivity = true;
            activity = described;
          }
        }
      } catch {
        // stream ended or aborted; polling covers completion
      }
    })();
  } catch (error) {
    input.logger.debug("event stream unavailable; relying on polling", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const sent = await client.prompt(sessionId, { text: input.text });
    baselineId = sent?.id ?? null;
  } catch (error) {
    cleanup();
    if (input.signal?.aborted) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
    }
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "OPENCODE_ERROR",
      `OpenCode rejected the prompt: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const outcome = await new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve;
    if (settled) return;

    timeoutTimer = setTimeout(() => {
      void interruptSession();
      settle({ kind: "timeout" });
    }, input.timeoutMs);
    timeoutTimer.unref?.();

    let ticking = false;
    const tick = async () => {
      if (settled || ticking) return;
      ticking = true;
      try {
        const elapsed = Date.now() - startedAt;
        let running = false;
        try {
          const active = await client.activeSessions();
          running = Boolean(active[sessionId]);
          pollFailures = 0;
        } catch (error) {
          pollFailures += 1;
          if (pollFailures >= MAX_POLL_FAILURES) {
            settle({
              kind: "unavailable",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        if (running) sawActivity = true;

        await emit({
          progress: Math.min(90, 5 + Math.floor(elapsed / 1000)),
          message: activity ?? "working…",
        });
        if (settled) return;

        if (running) return;

        if (sawActivity) {
          settle({ kind: "done" });
          return;
        }

        // Not seen running: it may have finished between two ticks.
        try {
          const messages = messagesAfter(await recentMessages(client, sessionId), baselineId);
          if (messages.some(isIdle)) {
            settle({ kind: "done" });
            return;
          }
        } catch {
          // keep polling
        }
        if (elapsed > ACCEPTANCE_GRACE_MS) settle({ kind: "not-accepted" });
      } finally {
        ticking = false;
      }
    };

    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
    void tick();
  });

  cleanup();
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "aborted" || abortedByCaller) {
    throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
  }

  if (outcome.kind === "unavailable") {
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `Lost contact with the OpenCode server while the run was active: ${outcome.message}`,
      { retryable: true },
    );
  }

  if (outcome.kind === "timeout") {
    await emit({ progress: 95, message: "timed out; interrupting session" });
    return {
      status: "timeout",
      summary: "",
      findings: [],
      error: {
        code: "AGENT_TIMEOUT",
        message: `Delegated run exceeded ${input.timeoutMs}ms and was aborted.`,
        details: { timeout_ms: input.timeoutMs },
      },
      durationMs,
      truncated: false,
    };
  }

  if (outcome.kind === "not-accepted") {
    return failedResult(
      {
        code: "AGENT_EXECUTION_FAILED",
        message: `OpenCode did not start the delegated run within ${ACCEPTANCE_GRACE_MS}ms.`,
        details: { session_id: sessionId },
      },
      durationMs,
    );
  }

  return finalize(input, baselineId, durationMs, emit);
}

async function finalize(
  input: RunPromptInput,
  baselineId: string | null,
  durationMs: number,
  emit: (progress: RunProgress) => Promise<void>,
): Promise<RunResult> {
  const { client, sessionId } = input;

  // The `idle` message is written right after the execution ends; give it a moment.
  let fresh: SessionMessage[] = [];
  let idle: IdleMessage | undefined;
  for (let attempt = 0; attempt < IDLE_MESSAGE_RETRIES; attempt += 1) {
    try {
      fresh = messagesAfter(await recentMessages(client, sessionId), baselineId);
    } catch (error) {
      if (attempt === IDLE_MESSAGE_RETRIES - 1) {
        throw new BridgeError(
          "OPENCODE_UNAVAILABLE",
          `Could not read the session messages: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error, retryable: true },
        );
      }
    }
    idle = [...fresh].reverse().find(isIdle);
    if (idle) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const assistants = fresh.filter(isAssistant);
  const lastWithText = [...assistants].reverse().find((message) => assistantText(message));
  const last = assistants.at(-1);
  const failedAssistant = [...assistants].reverse().find((message) => message.error);
  const messageID = (lastWithText ?? last)?.id;

  const failedOutcome = idle?.outcome === "failed" || (!idle && failedAssistant !== undefined);
  if (failedOutcome || idle?.outcome === "interrupted") {
    const errorPayload = idle?.error ?? failedAssistant?.error;
    const mapped =
      idle?.outcome === "interrupted" && !errorPayload
        ? { code: "AGENT_ABORTED", message: "The delegated run was interrupted." }
        : errorPayload
          ? describeError(errorPayload)
          : {
              code: "AGENT_EXECUTION_FAILED",
              message: "The delegated run failed.",
              details: { outcome: idle?.outcome ?? "unknown" },
            };
    return { ...failedResult(mapped, durationMs), ...(messageID ? { messageID } : {}) };
  }

  const summary = stripAnsi(assistantText(lastWithText));
  await emit({ progress: 100, message: "completed" });
  return {
    status: "completed",
    summary,
    findings: extractFindings(summary),
    durationMs,
    ...(messageID ? { messageID } : {}),
    truncated: false,
  };
}

function failedResult(mapped: RunErrorInfo, durationMs: number): RunResult {
  return {
    status: "failed",
    summary: "",
    findings: [],
    error: {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details ? { details: mapped.details } : {}),
    },
    durationMs,
    truncated: false,
  };
}
