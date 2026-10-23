import { describe, expect, it } from "vitest";
import { RunSlots } from "../../src/mcp/run-slots.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("RunSlots", () => {
  it("grants up to the limit immediately and queues the rest in FIFO order", async () => {
    const slots = new RunSlots(2);
    const order: string[] = [];
    const a = await slots.acquire("a");
    const b = await slots.acquire("b");
    const queued: number[] = [];
    const c = slots
      .acquire("c", undefined, (p) => queued.push(p))
      .then((r) => {
        order.push("c");
        return r;
      });
    const d = slots
      .acquire("d", undefined, (p) => queued.push(p))
      .then((r) => {
        order.push("d");
        return r;
      });
    expect(queued).toEqual([1, 2]);
    expect(slots.activeCount).toBe(2);
    expect(slots.position("d")).toBe(2);

    a();
    const releaseC = await c;
    expect(order).toEqual(["c"]);
    expect(slots.position("d")).toBe(1);
    b();
    const releaseD = await d;
    expect(order).toEqual(["c", "d"]);
    releaseC();
    releaseD();
    expect(slots.activeCount).toBe(0);
  });

  it("ignores a double release", async () => {
    const slots = new RunSlots(1);
    const release = await slots.acquire("a");
    release();
    release();
    expect(slots.activeCount).toBe(0);
  });

  it("removes an aborted waiter from the queue without taking a slot", async () => {
    const slots = new RunSlots(1);
    const release = await slots.acquire("a");
    const controller = new AbortController();
    const waiting = slots.acquire("b", controller.signal);
    const next = slots.acquire("c");
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "AGENT_ABORTED" });
    expect(slots.position("b")).toBeNull();
    expect(slots.position("c")).toBe(1);
    release();
    await next;
    await tick();
    expect(slots.activeCount).toBe(1);
  });

  it("rejects an already-aborted signal and invalid limits", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new RunSlots(1).acquire("a", controller.signal)).rejects.toMatchObject({
      code: "AGENT_ABORTED",
    });
    expect(() => new RunSlots(0)).toThrow(/maxConcurrentRuns/);
  });
});
