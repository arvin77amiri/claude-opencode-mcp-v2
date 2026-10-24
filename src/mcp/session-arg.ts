import { z } from "zod";
import { BridgeError } from "../errors.js";

/**
 * How the read-only session tools take a session id.
 *
 * Claude Desktop's remote path (remote-devices) was seen to deliver every argument except one
 * literally named `session_id` (the same call works through an SDK client over stdio). The id is
 * therefore taken as `session`; `session_id` stays accepted for clients that deliver it. Both are
 * optional in the schema so either spelling validates; `pickSessionId` enforces that one is present.
 */
export const sessionInput = {
  session: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Required. The session_id value from find_sessions (starts with ses)."),
  session_id: z.string().min(1).max(200).optional().describe("Alias of session; prefer session."),
};

/**
 * The same two spellings for the tools that act on a session the bridge delegated
 * (get_session, wait_session, get_diff, send_message, abort_session, merge_task, discard_task).
 */
export function sessionInputFor(what: string) {
  return {
    session: z.string().min(1).max(200).optional().describe(`Required. ${what}`),
    session_id: z.string().min(1).max(200).optional().describe("Alias of session; prefer session."),
  };
}

export interface SessionArgs {
  session?: string | undefined;
  session_id?: string | undefined;
}

/** The session id from either spelling, trimmed; INVALID_ARGUMENT when missing or not a ses id. */
export function pickSessionId(
  args: SessionArgs,
  options: { source?: string; requirePrefix?: boolean } = {},
): string {
  const raw = (args.session ?? args.session_id ?? "").trim();
  if (!raw) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Missing session: pass the session_id from ${options.source ?? "find_sessions"} as \`session\`.`,
    );
  }
  if (options.requirePrefix !== false && !raw.startsWith("ses")) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `"${raw}" is not a session id (they start with "ses"). Use a session_id from find_sessions.`,
    );
  }
  return raw;
}
