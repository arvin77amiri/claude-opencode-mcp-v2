import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { serializeError } from "../errors.js";
import type { RunProgress } from "../types/index.js";
import type { Logger } from "../util/logger.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface JsonResultOptions {
  isError?: boolean;
  /** One-line JSON instead of indented: smaller answers for the read-only catalog tools. */
  compact?: boolean;
  /** Set false to send the text block only (structuredContent would double the size). */
  structured?: boolean;
}

export function jsonResult(value: unknown, options: JsonResultOptions = {}): CallToolResult {
  const text =
    (options.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) ?? String(value);
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (options.structured !== false && value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  if (options.isError) result.isError = true;
  return result;
}

export function errorResult(error: unknown, requestId?: string): CallToolResult {
  return jsonResult({ error: serializeError(error, requestId) }, { isError: true });
}

export type ProgressReporter = (progress: RunProgress) => Promise<void>;

export function createProgressReporter(
  extra: ToolExtra,
  logger: Logger,
  requestId: string,
): ProgressReporter | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined || token === null) return undefined;
  let lastSentAt = 0;
  return async (progress: RunProgress) => {
    const now = Date.now();
    if (progress.progress < 100 && now - lastSentAt < 400) return;
    lastSentAt = now;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: progress.progress,
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...(progress.message ? { message: progress.message } : {}),
        },
      });
    } catch (error) {
      logger.debug("failed to send progress notification", {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
