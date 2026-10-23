import { BridgeError } from "../errors.js";

interface Waiter {
  key: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * Cap on concurrent delegated runs (`limits.maxConcurrentRuns`), shared by blocking and
 * background calls. Runs beyond the cap wait in a FIFO queue instead of failing, so an
 * orchestrator can fan out freely; each waiter can be cancelled through its AbortSignal
 * (abort_session, the MCP request being cancelled, or bridge shutdown).
 */
export class RunSlots {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BridgeError(
        "CONFIG_INVALID",
        "limits.maxConcurrentRuns must be a positive integer",
      );
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** 1-based queue position of `key`, or null when it is not waiting. */
  position(key: string): number | null {
    const index = this.queue.findIndex((waiter) => waiter.key === key);
    return index === -1 ? null : index + 1;
  }

  /**
   * Resolve with a release function once a slot is free. `onQueued` is called once,
   * synchronously, when the caller has to wait.
   */
  acquire(
    key: string,
    signal?: AbortSignal,
    onQueued?: (position: number) => void,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(aborted());
    }
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(aborted());
      };
      const waiter: Waiter = {
        key,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      onQueued?.(this.queue.length);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift() as Waiter;
      next.cleanup();
      this.active += 1;
      next.resolve(this.releaser());
    }
  }
}

function aborted(): BridgeError {
  return new BridgeError(
    "AGENT_ABORTED",
    "Delegated run was cancelled while waiting for a free slot.",
  );
}
