import { BridgeError, isBridgeError } from "../errors.js";
import { OpenCodeApiError, type OpenCodeClient } from "../opencode/client.js";
import type { AppContext } from "./execute.js";

/**
 * Client for read-only tools. It NEVER starts OpenCode (the bridge must not add a second
 * engine next to OpenCode Desktop):
 * - desktop / external-url mode: connect to the running server (reads service.json, GET /api/info);
 * - local mode: use the connection a delegated task already opened, otherwise fail clearly.
 */
export async function readOnlyClient(ctx: AppContext): Promise<OpenCodeClient> {
  const config = ctx.globalConfig;
  if (config.opencode.desktop || config.opencode.url) {
    return ctx.manager.clientFor({ cwd: process.cwd(), config, agentConfig: {} });
  }
  const existing = ctx.manager.existingClient();
  if (existing) return existing;
  throw new BridgeError(
    "OPENCODE_UNAVAILABLE",
    "No OpenCode server is connected, and this read-only tool never starts one. " +
      'Set "opencode": {"desktop": true} (OpenCode Desktop must be running) or start a delegated task first.',
  );
}

/** Turn an OpenCode API failure into a structured bridge error; other errors pass through. */
export function asBridgeError(error: unknown): unknown {
  if (isBridgeError(error) || !(error instanceof OpenCodeApiError)) return error;
  return new BridgeError("OPENCODE_ERROR", error.message, {
    details: { status: error.status, path: error.path },
    cause: error,
  });
}
