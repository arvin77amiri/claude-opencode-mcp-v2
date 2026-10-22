import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import type { AuthCredentials } from "./client.js";

/**
 * Discovery of the OpenCode Desktop background service.
 *
 * OpenCode Desktop (2.1+) runs one `opencode-cli` service and records how to reach it in
 * `service.json` (`id`, `version`, `url`, `pid`, `password`). The port and the password
 * change every time the app starts, so a static `opencode.url` in the bridge config goes
 * stale. With `opencode.desktop: true` the bridge reads this file instead, re-reads it
 * before every run, and never spawns an engine of its own: when the app is closed it fails
 * with a clear OPENCODE_UNAVAILABLE instead of starting a second server.
 *
 * The password is only ever returned inside `auth`; nothing here logs it.
 */

export interface DesktopService {
  file: string;
  url: string;
  pid: number;
  version: string | null;
  id: string | null;
  auth: AuthCredentials | null;
}

/** Default location: `$XDG_STATE_HOME/opencode/service.json`, else `~/.local/state/...`. */
export function desktopServiceFile(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg || path.join(os.homedir(), ".local", "state");
  return path.join(base, "opencode", "service.json");
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const CLOSED_HINT =
  "Open OpenCode Desktop and retry; the bridge never starts its own engine in desktop mode.";

export interface ReadDesktopServiceOptions {
  file?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  pidAlive?: (pid: number) => boolean;
}

export function readDesktopService(options: ReadDesktopServiceOptions = {}): DesktopService {
  const env = options.env ?? process.env;
  const file = options.file?.trim() ? path.resolve(options.file) : desktopServiceFile(env);
  const pidAlive = options.pidAlive ?? isPidAlive;

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      code === "ENOENT"
        ? `OpenCode Desktop service not found (no ${file}). ${CLOSED_HINT}`
        : `Could not read the OpenCode Desktop service file ${file}.`,
      { details: { file, reason: error instanceof Error ? error.message : String(error) } },
    );
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw.replace(/^﻿/, "")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch (error) {
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `OpenCode Desktop service file ${file} is not valid JSON.`,
      {
        details: { file, reason: error instanceof Error ? error.message : String(error) },
      },
    );
  }

  const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
  if (!url || !Number.isInteger(pid)) {
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `OpenCode Desktop service file ${file} has no usable url/pid.`,
      { details: { file, fields: Object.keys(parsed) } },
    );
  }
  if (!pidAlive(pid)) {
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `OpenCode Desktop is not running (service file ${file} is stale: pid ${pid} has exited). ${CLOSED_HINT}`,
      { details: { file, pid } },
    );
  }

  const password = typeof parsed.password === "string" && parsed.password ? parsed.password : null;
  const username =
    typeof parsed.username === "string" && parsed.username ? parsed.username : "opencode";
  return {
    file,
    url,
    pid,
    version: typeof parsed.version === "string" ? parsed.version : null,
    id: typeof parsed.id === "string" ? parsed.id : null,
    auth: password ? { username, password } : null,
  };
}

/** Identity of one service instance; a different value means the app was restarted. */
export function serviceFingerprint(service: DesktopService): string {
  return createHash("sha256")
    .update(JSON.stringify([service.url, service.pid, service.id, service.auth?.password ?? null]))
    .digest("hex");
}
