import { describe, expect, it } from "vitest";
import {
  buildDigest,
  cutText,
  DIGEST_MAX_CHARS,
  DIGEST_MAX_PAGES,
  DIGEST_PAGE_SIZE,
  digestSession,
  fitDigest,
  lightMessage,
} from "../../src/opencode/session-digest.js";
import {
  assistant,
  compaction,
  idle,
  MessageStub,
  type RawMessage,
  text,
  tool,
  user,
} from "../helpers/message-stub.js";

const DIR = "C:\\work\\demo";

function failedSession(): RawMessage[] {
  return [
    user(
      "msg_01",
      `Fix the flaky deploy. ${"The deploy fails on step 3 with a timeout. ".repeat(20)}`,
      1,
    ),
    assistant(
      "msg_02",
      [
        { type: "reasoning", text: "REASONING-MARKER" },
        tool("read", { path: `${DIR}\\src\\deploy.ts` }),
        tool("write", {
          path: `${DIR}\\src\\retry.ts`,
          content: "WRITE-CONTENT-MARKER".repeat(50),
        }),
        tool("edit", { filePath: `${DIR}\\src\\deploy.ts`, oldString: "a", newString: "b" }),
        tool("edit", { filePath: `${DIR}\\src\\deploy.ts`, oldString: "b", newString: "c" }),
        tool(
          "shell",
          { command: "npm test" },
          { status: "error", error: { type: "ShellError", message: "exit code 1: tests failed" } },
        ),
        text("Added retries."),
      ],
      { finish: "tool-calls" },
      2,
    ),
    compaction("msg_03", `Summary of the work so far. ${"Retries were added. ".repeat(60)}`, 3),
    user("msg_04", "Now also add exponential backoff and re-run the tests.", 4),
    assistant(
      "msg_05",
      [text("Trying again.")],
      {
        finish: "error",
        error: { type: "ProviderError", status: 429, message: "Free usage limit reached" },
      },
      5,
    ),
    idle("msg_06", "failed", { type: "ProviderError", message: "Free usage limit reached" }, 6),
  ];
}

describe("lightMessage", () => {
  it("keeps names, edited paths and errors but no content", () => {
    const [, second] = failedSession();
    const light = lightMessage(second);
    expect(light).toMatchObject({
      id: "msg_02",
      type: "assistant",
      at: 2,
      finish: "tool-calls",
      tools: ["read", "write", "edit", "edit", "shell"],
      files: [`${DIR}\\src\\retry.ts`, `${DIR}\\src\\deploy.ts`],
      errors: [{ type: "tool:shell", message: "exit code 1: tests failed" }],
    });
    expect(JSON.stringify(light)).not.toContain("WRITE-CONTENT-MARKER");
    expect(JSON.stringify(light)).not.toContain("REASONING-MARKER");
  });

  it("records finish:error without an error object and idle errors", () => {
    expect(lightMessage(assistant("m1", [text("x")], { finish: "error" }))?.errors).toEqual([
      { type: "finish_error", message: "assistant finished with an error" },
    ]);
    expect(lightMessage(idle("m2", "failed", { type: "Boom", message: "bad" }))?.errors).toEqual([
      { type: "Boom", message: "bad" },
    ]);
    expect(lightMessage({ type: "user" })).toBeNull();
  });
});

describe("buildDigest", () => {
  async function digestOf(
    messages: RawMessage[],
    session = { title: "Fix deploy", location: { directory: DIR } },
  ) {
    return digestSession(new MessageStub(messages, session as never), "ses_1");
  }

  it("builds goal, last request, summary, files, errors, final state, tools and counts", async () => {
    const digest = await digestOf(failedSession());
    expect(digest.title).toBe("Fix deploy");
    expect(digest.goal?.startsWith("Fix the flaky deploy.")).toBe(true);
    expect(digest.goal?.length).toBeLessThanOrEqual(300);
    expect(digest.last_request).toBe("Now also add exponential backoff and re-run the tests.");
    expect(digest.compaction_summary?.startsWith("Summary of the work so far.")).toBe(true);
    expect(digest.compaction_summary?.length).toBeLessThanOrEqual(600);
    // Deduplicated, relative to the session folder.
    expect(digest.files_changed).toEqual(["src\\retry.ts", "src\\deploy.ts"]);
    // Newest first; the assistant error and the idle error are the same failure, listed once,
    // pointing to the assistant message (msg_05) with the idle message as idle_msg_id.
    expect(digest.errors).toEqual([
      {
        msg_id: "msg_05",
        idle_msg_id: "msg_06",
        type: "ProviderError",
        message: "Free usage limit reached",
      },
      { msg_id: "msg_02", type: "tool:shell", message: "exit code 1: tests failed" },
    ]);
    expect(digest.final_state).toEqual({
      outcome: "failed",
      finish: "error",
      idle_error: { type: "ProviderError", message: "Free usage limit reached" },
    });
    expect(digest.tools_used).toEqual({ edit: 2, read: 1, shell: 1, write: 1 });
    expect(digest.counts).toEqual({ messages: 6, user: 2, assistant: 2 });
    expect(digest.fingerprint).toBe("msg_06@6:failed");
    expect(digest.partial).toBeUndefined();
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("points a shared assistant/idle error at the assistant message and adds idle_msg_id", async () => {
    const digest = await digestOf([
      user("msg_1", "go", 1),
      assistant(
        "msg_2",
        [text("working")],
        { finish: "error", error: { type: "Boom", message: "provider down" } },
        2,
      ),
      idle("msg_3", "failed", { type: "Boom", message: "provider down" }, 3),
    ]);
    expect(digest.errors).toEqual([
      { msg_id: "msg_2", idle_msg_id: "msg_3", type: "Boom", message: "provider down" },
    ]);
  });

  it("keeps the idle message as msg_id when only the idle message has the error", async () => {
    const digest = await digestOf([
      user("msg_1", "go", 1),
      assistant("msg_2", [text("working")], { finish: "stop" }, 2),
      idle("msg_3", "failed", { type: "Crash", message: "run failed" }, 3),
    ]);
    expect(digest.errors).toEqual([{ msg_id: "msg_3", type: "Crash", message: "run failed" }]);
    expect(digest.errors[0]).not.toHaveProperty("idle_msg_id");
  });

  it("does not merge different errors of the assistant and the idle message", async () => {
    const digest = await digestOf([
      assistant(
        "msg_2",
        [text("x")],
        { finish: "error", error: { type: "A", message: "first" } },
        2,
      ),
      idle("msg_3", "failed", { type: "B", message: "second" }, 3),
    ]);
    expect(digest.errors.map((error) => error.msg_id)).toEqual(["msg_3", "msg_2"]);
    expect(digest.errors.every((error) => !("idle_msg_id" in error))).toBe(true);
  });

  it("never carries reasoning, file content or tool output", async () => {
    const digest = JSON.stringify(await digestOf(failedSession()));
    expect(digest).not.toContain("REASONING-MARKER");
    expect(digest).not.toContain("WRITE-CONTENT-MARKER");
  });

  it("handles an empty session", async () => {
    const digest = await digestOf([], { title: "Empty", location: { directory: DIR } });
    expect(digest).toMatchObject({
      title: "Empty",
      files_changed: [],
      errors: [],
      final_state: { outcome: "unknown" },
      tools_used: {},
      counts: { messages: 0, user: 0, assistant: 0 },
      fingerprint: "empty:unknown",
    });
    expect(digest.goal).toBeUndefined();
  });

  it("falls back to the session outcome when there is no idle message", async () => {
    const digest = await digestSession(
      new MessageStub([user("msg_1", "hi")], { title: "t", outcome: "interrupted" }),
      "ses_1",
    );
    expect(digest.final_state.outcome).toBe("interrupted");
    expect(digest.fingerprint).toBe("msg_1@1:interrupted");
  });

  it("describes an attachment-only first message", () => {
    const digest = buildDigest({
      session: { title: "t" },
      firstUser: {
        id: "m1",
        type: "user",
        text: "",
        files: [{ name: "shot.png", data: "BASE64" }],
      },
      records: [],
      scanComplete: true,
      gaps: false,
    });
    expect(digest.goal).toBe("[attachment: shot.png]");
  });
});

describe("digestSession reading", () => {
  it("uses the targeted GETs and never sends order together with a cursor", async () => {
    const stub = new MessageStub(failedSession(), { title: "t" });
    await digestSession(stub, "ses_1");
    const targeted = stub.calls.filter((call) => call.limit === 1);
    expect(targeted).toEqual(
      expect.arrayContaining([
        { type: "user", order: "asc", limit: 1 },
        { type: "user", order: "desc", limit: 1 },
        { type: "compaction", order: "desc", limit: 1 },
        { type: "idle", order: "desc", limit: 1 },
        { order: "desc", limit: 1 },
      ]),
    );
    expect(stub.neverOrderWithCursor).toBe(true);
  });

  it("pages through a long session and counts every message", async () => {
    const messages: RawMessage[] = [user("msg_0000", "start the work")];
    for (let index = 1; index <= 249; index += 1) {
      messages.push(
        assistant(
          `msg_${String(index).padStart(4, "0")}`,
          [tool("read", { path: "a.ts" })],
          {},
          index,
        ),
      );
    }
    const stub = new MessageStub(messages, { title: "long" });
    const digest = await digestSession(stub, "ses_1");
    expect(digest.counts).toEqual({ messages: 250, user: 1, assistant: 249 });
    expect(digest.tools_used).toEqual({ read: 249 });
    expect(digest.partial).toBeUndefined();
    expect(stub.neverOrderWithCursor).toBe(true);
    // 250 messages = 3 pages (100, 100, 50).
    expect(stub.calls.filter((call) => call.limit === DIGEST_PAGE_SIZE)).toHaveLength(3);
  });

  it("reports partial when the page cap is reached", async () => {
    const total = DIGEST_PAGE_SIZE * DIGEST_MAX_PAGES + 50;
    const messages = Array.from({ length: total }, (_, index) =>
      user(`msg_${String(index).padStart(5, "0")}`, "x", index),
    );
    const digest = await digestSession(new MessageStub(messages, { title: "huge" }), "ses_1");
    expect(digest.partial).toBe(true);
    expect(digest.counts.messages).toBe(DIGEST_PAGE_SIZE * DIGEST_MAX_PAGES);
  });

  it("reports partial when a side request fails but still answers", async () => {
    const stub = new MessageStub(
      failedSession(),
      { title: "t", outcome: "failed" },
      { failType: "idle" },
    );
    const digest = await digestSession(stub, "ses_1");
    expect(digest.partial).toBe(true);
    expect(digest.final_state.outcome).toBe("failed");
    // The failure is still caught from the assistant message in the scan.
    expect(digest.errors.some((error) => error.message === "Free usage limit reached")).toBe(true);
  });
});

describe("fitDigest", () => {
  function hugeSession(): RawMessage[] {
    const messages: RawMessage[] = [user("msg_0001", "goal ".repeat(200), 1)];
    for (let index = 2; index <= 60; index += 1) {
      messages.push(
        assistant(
          `msg_${String(index).padStart(4, "0")}`,
          [
            tool("write", { path: `${DIR}\\src\\generated\\module-with-a-long-name-${index}.ts` }),
            tool(
              "shell",
              { command: "x" },
              { status: "error", error: { type: `Err${index}`, message: "e".repeat(400) } },
            ),
          ],
          {},
          index,
        ),
      );
    }
    messages.push(compaction("msg_0100", "summary ".repeat(300), 100));
    messages.push(user("msg_0101", "last ".repeat(200), 101));
    messages.push(idle("msg_0102", "failed", { type: "Boom", message: "m".repeat(500) }, 102));
    return messages;
  }

  it("keeps a huge session under the cap and marks it truncated", async () => {
    const stub = new MessageStub(hugeSession(), {
      title: "T".repeat(300),
      location: { directory: DIR },
    } as never);
    const digest = await digestSession(stub, "ses_1");
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.truncated).toBe(true);
    expect(digest.files_total).toBe(59);
    expect(digest.files_changed.length).toBeGreaterThan(0);
    expect(digest.errors.length).toBeGreaterThan(0);
    // The newest failure (the idle error) always survives.
    expect(digest.errors[0]?.type).toBe("Boom");
    expect(digest.counts.messages).toBe(63);
    expect(digest.fingerprint).toContain("msg_0102@102:failed");
  });

  it("applies the per-field caps without truncating a small digest", async () => {
    const small = [
      user("msg_1", "fix the typo in the readme", 1),
      assistant(
        "msg_2",
        [tool("edit", { filePath: "README.md" }), text("Done.")],
        { finish: "stop" },
        2,
      ),
      idle("msg_3", "succeeded", undefined, 3),
    ];
    const digest = await digestSession(new MessageStub(small, { title: "t" }), "ses_1");
    expect(digest.truncated).toBeUndefined();
    expect(digest.files_changed).toEqual(["README.md"]);
    expect(fitDigest(digest)).toBe(digest);
  });

  it("cuts text on whitespace-collapsed length with an ellipsis", () => {
    expect(cutText("a   b\n c", 20)).toBe("a b c");
    expect(cutText("abcdefghij", 5)).toBe("abcd…");
  });
});
