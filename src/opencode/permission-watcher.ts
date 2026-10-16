import type { Logger } from "../util/logger.js";
import type { PermissionRequest } from "./api-types.js";
import type { OpenCodeClient } from "./client.js";

const POLL_INTERVAL_MS = 1500;

/**
 * Rejects permission requests that would otherwise wait forever (the bridge is
 * headless: there is no human to answer an `ask`). The sessions the bridge
 * creates never carry `ask` rules, but an OpenCode agent or the user's global
 * configuration might.
 *
 * Two complementary sources are used:
 *  - the SSE stream (`GET /api/event`), event `permission.asked`, for low latency;
 *  - polling `GET /api/session/{id}/permission` for active sessions, which
 *    guarantees progress even if the event name differs between releases.
 */
export class PermissionWatcher {
  private readonly active = new Set<string>();
  private readonly handled = new Set<string>();
  private controller: AbortController | null = null;
  private loops: Promise<void>[] = [];
  private stopped = false;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly logger: Logger,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {}

  activate(sessionId: string): void {
    this.active.add(sessionId);
    this.ensureStarted();
  }

  deactivate(sessionId: string): void {
    this.active.delete(sessionId);
  }

  private ensureStarted(): void {
    if (this.stopped || this.controller) return;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.loops = [this.streamLoop(signal), this.pollLoop(signal)];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
    this.controller = null;
  }

  private async streamLoop(signal: AbortSignal): Promise<void> {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        const events = await this.client.openEvents(signal);
        delay = 1000;
        for await (const event of events) {
          if (event.type !== "permission.asked") continue;
          const request = asRequest(event.data);
          if (request && this.active.has(request.sessionID)) void this.reject(request);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.logger.debug("permission watcher stream disconnected; retrying", {
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted) return;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.pollIntervalMs, signal);
      for (const sessionId of [...this.active]) {
        if (signal.aborted) return;
        try {
          for (const request of await this.client.pendingPermissions(sessionId)) {
            await this.reject(request);
          }
        } catch {
          // transient or unsupported; the SSE path may still catch it
        }
      }
    }
  }

  private async reject(request: PermissionRequest): Promise<void> {
    if (this.handled.has(request.id)) return;
    this.handled.add(request.id);
    if (this.handled.size > 1000) {
      const first = this.handled.values().next().value;
      if (first !== undefined) this.handled.delete(first);
    }
    this.logger.warn("auto-rejecting OpenCode permission request (headless bridge)", {
      sessionID: request.sessionID,
      permissionID: request.id,
      action: request.action,
      resources: request.resources,
    });
    try {
      await this.client.replyPermission(
        request.sessionID,
        request.id,
        "reject",
        "The bridge runs headless; permission requests are rejected automatically.",
      );
    } catch (error) {
      this.logger.warn("failed to reject permission request", {
        permissionID: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function asRequest(data: Record<string, unknown>): PermissionRequest | null {
  const candidate = (
    data && typeof data.request === "object" && data.request
      ? (data.request as Record<string, unknown>)
      : data
  ) as Record<string, unknown>;
  const id = candidate.id ?? candidate.requestID;
  const sessionID = candidate.sessionID;
  if (typeof id !== "string" || typeof sessionID !== "string") return null;
  return {
    id,
    sessionID,
    action: typeof candidate.action === "string" ? candidate.action : "unknown",
    resources: Array.isArray(candidate.resources) ? (candidate.resources as string[]) : [],
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
