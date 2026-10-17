import { describe, expect, it } from "vitest";
import { latestActivity } from "../../src/opencode/activity.js";

describe("latestActivity", () => {
  it("returns null without timestamps", () => {
    expect(latestActivity([])).toBeNull();
  });

  it("picks the newest content part", () => {
    const activity = latestActivity([
      { id: "m1", type: "user", time: { created: 100 } },
      {
        id: "m2",
        type: "assistant",
        time: { created: 200, streamed: 250 },
        content: [
          { type: "reasoning", time: { created: 210, completed: 220 } },
          {
            type: "tool",
            name: "write",
            state: { status: "completed" },
            time: { created: 300, ran: 320, completed: 330 },
          },
        ],
      },
    ]);
    expect(activity).toEqual({ at: 330, summary: "tool write (completed)" });
  });
});
