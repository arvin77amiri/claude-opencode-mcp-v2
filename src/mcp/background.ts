import { type SerializedBridgeError, serializeError } from "../errors.js";
import type { DelegateResult } from "../types/index.js";
import type { Logger } from "../util/logger.js";

export type BackgroundState = "queued" | "running" | "done";

interface BackgroundRun {
  sessionId: string;
  state: BackgroundState;
  startedAt: number;
  finishedAt: number | null;
  controller: AbortController;
  promise: Promise<void>;
  result: DelegateResult | null;
  error: SerializedBridgeError | null;
}

export interface BackgroundSnapshot {
  state: BackgroundState;
  started_at: string;
  finished_at: string | null;
  result: DelegateResult | null;
  error: SerializedBridgeError | null;
}

export interface BackgroundHooks {
  signal: AbortSignal;
  /** Called by the run once it holds a slot and is actually executing. */
  markRunning: () => void;
}

/**
 * Runs started with `background: true`. The tool call returns immediately; the run keeps
 * going here and its result stays in memory (one per session, replaced by the next
 * background run) until `wait_session` or `get_session` reads it.
 *
 * Every run owns an AbortController, so abort_session and bridge shutdown can stop it:
 * the OpenCode Desktop service outlives the bridge, and an orphaned agent would keep
 * editing files with nobody supervising it.
 */
export class BackgroundRuns {
  private readonly runs = new Map<string, BackgroundRun>();

  constructor(private readonly logger: Logger) {}

  isActive(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    return !!run && run.state !== "done";
  }

  start(sessionId: string, execute: (hooks: BackgroundHooks) => Promise<DelegateResult>): void {
    const controller = new AbortController();
    const run: BackgroundRun = {
      sessionId,
      state: "queued",
      startedAt: Date.now(),
      finishedAt: null,
      controller,
      promise: Promise.resolve(),
      result: null,
      error: null,
    };
    this.runs.set(sessionId, run);
    run.promise = execute({
      signal: controller.signal,
      markRunning: () => {
        if (run.state === "queued") run.state = "running";
      },
    })
      .then(
        (result) => {
          run.result = result;
        },
        (error: unknown) => {
          run.error = serializeError(error);
          this.logger.warn("background run failed", {
            session_id: sessionId,
            error: run.error.message,
          });
        },
      )
      .finally(() => {
        run.state = "done";
        run.finishedAt = Date.now();
      });
  }

  snapshot(sessionId: string): BackgroundSnapshot | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    return {
      state: run.state,
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      result: run.result,
      error: run.error,
    };
  }

  /** Wait up to `timeoutMs` for the run to finish; resolves with the latest snapshot. */
  async wait(
    sessionId: string,
    timeoutMs: number,
    onTick?: (snapshot: BackgroundSnapshot) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot | null> {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    const deadline = Date.now() + timeoutMs;
    // A function, not a narrowed property read: the state changes across the awaits below.
    const done = (): boolean => run.state === "done";
    while (!done() && Date.now() < deadline && !signal?.aborted) {
      const remaining = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        run.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(remaining, 5_000));
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!done() && onTick) await onTick(this.snapshot(sessionId) as BackgroundSnapshot);
    }
    return this.snapshot(sessionId);
  }

  /** Cancel a queued or running background run. Returns false when none is active. */
  abort(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || run.state === "done") return false;
    run.controller.abort();
    return true;
  }

  /** Abort every active run and wait (bounded) for them to wind down. */
  async abortAll(graceMs = 5_000): Promise<void> {
    const active = [...this.runs.values()].filter((run) => run.state !== "done");
    if (active.length === 0) return;
    this.logger.info("stopping background runs", { count: active.length });
    for (const run of active) run.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(active.map((run) => run.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
