import { describe, expect, it } from "vitest";
import {
  type MessageView,
  READ_MAX_CHARS,
  READ_PAGE_SIZE,
  READ_PER_MESSAGE_CHARS,
  readMessages,
  shrinkView,
  takeWithinBudget,
} from "../../src/opencode/message-reader.js";
import {
  assistant,
  compaction,
  MessageStub,
  type RawMessage,
  text,
  tool,
  user,
} from "../helpers/message-stub.js";

const pad = (index: number): string => `msg_${String(index).padStart(3, "0")}`;

/** 230 messages: odd = user, even = assistant with a tool call; msg_105 is a synthetic marker. */
function longSession(): RawMessage[] {
  return Array.from({ length: 230 }, (_, offset): RawMessage => {
    const index = offset + 1;
    if (index === 105) return { id: pad(index), type: "synthetic", text: "marker" };
    if (index % 2 === 1) return user(pad(index), `question ${index}`, index);
    return assistant(
      pad(index),
      [
        { type: "reasoning", text: "REASONING-MARKER" },
        tool(
          "read",
          { path: `src/f${index}.ts` },
          {
            status: "completed",
            content: [{ type: "text", text: "RAW-OUTPUT-MARKER" }],
          },
        ),
        text(`answer ${index}`),
      ],
      { finish: "stop" },
      index,
    );
  });
}

const ids = (views: Array<{ id: string }>): string[] => views.map((view) => view.id);

describe("read_messages by id", () => {
  it("returns the messages in the requested order with compact tools", async () => {
    const stub = new MessageStub(longSession());
    const answer = await readMessages(stub, {
      sessionId: "ses_1",
      messageIds: ["msg_004", "msg_003"],
    });
    expect(ids(answer.messages)).toEqual(["msg_004", "msg_003"]);
    expect(answer.messages[0]).toEqual({
      id: "msg_004",
      type: "assistant",
      time: new Date(4).toISOString(),
      text: "answer 4",
      tools: [{ name: "read", status: "completed", input_summary: "src/f4.ts" }],
      finish: "stop",
      truncated: false,
    });
    expect(answer.messages[1]).toMatchObject({ id: "msg_003", type: "user", text: "question 3" });
    expect(answer.more).toBeUndefined();
    const json = JSON.stringify(answer);
    expect(json).not.toContain("REASONING-MARKER");
    expect(json).not.toContain("RAW-OUTPUT-MARKER");
  });

  it("reports unknown ids and shows a message without readable content as a note", async () => {
    const answer = await readMessages(new MessageStub(longSession()), {
      sessionId: "ses_1",
      messageIds: ["msg_105", "msg_nope", "msg_001"],
    });
    expect(answer.missing_ids).toEqual(["msg_nope"]);
    expect(answer.messages[0]).toMatchObject({
      id: "msg_105",
      type: "synthetic",
      note: "no readable content",
    });
    expect(ids(answer.messages)).toEqual(["msg_105", "msg_001"]);
  });

  it("never writes file contents or shell output of a tool", async () => {
    const stub = new MessageStub([
      assistant("msg_1", [
        tool("write", { path: "a.ts", content: "SECRET-FILE-CONTENT" }, { status: "completed" }),
        tool("shell", { command: "npm test" }, { status: "error", error: { message: "exit 1" } }),
      ]),
    ]);
    const answer = await readMessages(stub, { sessionId: "ses_1", messageIds: ["msg_1"] });
    expect(JSON.stringify(answer)).not.toContain("SECRET-FILE-CONTENT");
    expect(answer.messages[0]?.tools).toEqual([
      { name: "write", status: "completed", input_summary: "a.ts" },
      { name: "shell", status: "error", input_summary: "npm test", error: "exit 1" },
    ]);
  });

  it("stops at the budget, sets more and lists the ids that were left out", async () => {
    const wordy = Array.from({ length: 12 }, (_, index) =>
      user(`msg_${index + 1}`, `message ${index + 1} ${"word ".repeat(40)}`),
    );
    const answer = await readMessages(new MessageStub(wordy), {
      sessionId: "ses_1",
      messageIds: wordy.map((message) => message.id),
      maxChars: 1_000,
    });
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(1_000);
    expect(answer.more).toBe(true);
    expect(answer.messages.length).toBeGreaterThan(0);
    expect(answer.messages.length).toBeLessThan(12);
    // What was read plus what remains is everything asked for, with nothing repeated.
    const left = answer.remaining_ids ?? [];
    expect(left.length).toBeGreaterThan(0);
    expect(new Set([...ids(answer.messages), ...left]).size).toBe(
      ids(answer.messages).length + left.length,
    );
  });

  it("cuts one long message to the budget and marks it truncated", async () => {
    const stub = new MessageStub([user("msg_1", "long ".repeat(2_000)), user("msg_2", "next")]);
    const answer = await readMessages(stub, {
      sessionId: "ses_1",
      messageIds: ["msg_1", "msg_2"],
      maxChars: 600,
    });
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(600);
    expect(answer.messages[0]?.truncated).toBe(true);
    expect(answer.more).toBe(true);
  });
});

describe("read_messages per-message cap", () => {
  const big = (index: number, size = 3_000) =>
    user(`msg_${index}`, `m${index} ${"x".repeat(size)}`, index);

  it("has the new defaults", () => {
    expect(READ_MAX_CHARS).toBe(6_000);
    expect(READ_PER_MESSAGE_CHARS).toBe(1_200);
  });

  it("fits several long messages into the default budget, each cut with a marker", async () => {
    const messages = [1, 2, 3, 4].map((index) => big(index));
    const answer = await readMessages(new MessageStub(messages), {
      sessionId: "ses_1",
      messageIds: messages.map((message) => message.id),
    });
    expect(ids(answer.messages)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(answer.more).toBeUndefined();
    expect(answer.remaining_ids).toBeUndefined();
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(READ_MAX_CHARS);
    for (const message of answer.messages) {
      expect(message.truncated).toBe(true);
      expect(message.text).toMatch(/\[truncated \d+ chars\]$/);
      expect((message.text ?? "").length).toBeLessThanOrEqual(READ_PER_MESSAGE_CHARS + 30);
    }
    expect(answer.messages[0]?.text).toContain("[truncated 1803 chars]");
  });

  it("leaves a message under the cap alone and honours a larger per_message_chars", async () => {
    const stub = new MessageStub([big(1)]);
    const small = await readMessages(stub, {
      sessionId: "ses_1",
      messageIds: ["msg_1"],
      perMessageChars: 4_000,
    });
    expect(small.messages[0]?.truncated).toBe(false);
    expect(small.messages[0]?.text).not.toContain("[truncated");
    expect(small.messages[0]?.text?.length).toBe(3_003);
  });

  it("honours a smaller per_message_chars and applies it to compaction summaries too", async () => {
    const answer = await readMessages(
      new MessageStub([big(1), compaction("msg_2", "s".repeat(900))]),
      {
        sessionId: "ses_1",
        messageIds: ["msg_1", "msg_2"],
        perMessageChars: 300,
      },
    );
    expect(answer.messages[0]?.text).toMatch(/^m1 x+ \[truncated 2703 chars\]$/);
    expect(answer.messages[1]?.text).toContain("[truncated 600 chars]");
  });

  it("applies the cap in around mode as well", async () => {
    const answer = await readMessages(new MessageStub([big(1), big(2), big(3)]), {
      sessionId: "ses_1",
      around: "msg_2",
      before: 1,
      after: 1,
    });
    expect(ids(answer.messages)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(answer.messages.every((message) => message.truncated)).toBe(true);
  });

  it("still reports more and remaining_ids when the budget is exceeded", async () => {
    const messages = [1, 2, 3, 4, 5].map((index) => big(index));
    const answer = await readMessages(new MessageStub(messages), {
      sessionId: "ses_1",
      messageIds: messages.map((message) => message.id),
      maxChars: 2_000,
    });
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(2_000);
    expect(answer.more).toBe(true);
    expect((answer.remaining_ids ?? []).length).toBeGreaterThan(0);
  });
});

describe("read_messages around", () => {
  it("shows the neighbours of a message on the first page", async () => {
    const stub = new MessageStub(longSession());
    const answer = await readMessages(stub, { sessionId: "ses_1", around: "msg_010" });
    // Defaults: 1 before, 2 after.
    expect(ids(answer.messages)).toEqual(["msg_009", "msg_010", "msg_011", "msg_012"]);
    expect(stub.neverOrderWithCursor).toBe(true);
    // Found on the first page: one request.
    expect(stub.calls).toHaveLength(1);
  });

  it("reads the neighbours that sit on the next page", async () => {
    const stub = new MessageStub(longSession());
    const answer = await readMessages(stub, {
      sessionId: "ses_1",
      around: pad(READ_PAGE_SIZE),
      before: 1,
      after: 2,
    });
    expect(ids(answer.messages)).toEqual(["msg_099", "msg_100", "msg_101", "msg_102"]);
    expect(stub.neverOrderWithCursor).toBe(true);
  });

  it("skips messages without readable content when counting neighbours", async () => {
    const answer = await readMessages(new MessageStub(longSession()), {
      sessionId: "ses_1",
      around: "msg_104",
      before: 1,
      after: 2,
    });
    expect(ids(answer.messages)).toEqual(["msg_103", "msg_104", "msg_106", "msg_107"]);
  });

  it("finds a message near the end through the newest page, including older neighbours", async () => {
    const stub = new MessageStub(longSession());
    // msg_131 is the oldest message of the newest page: its neighbours before are on the page before.
    const answer = await readMessages(stub, {
      sessionId: "ses_1",
      around: "msg_131",
      before: 2,
      after: 1,
    });
    expect(ids(answer.messages)).toEqual(["msg_129", "msg_130", "msg_131", "msg_132"]);
    expect(stub.neverOrderWithCursor).toBe(true);
  });

  it("finds a message in the middle of a long session", async () => {
    const stub = new MessageStub(longSession());
    const answer = await readMessages(stub, {
      sessionId: "ses_1",
      around: "msg_120",
      after: 1,
      before: 0,
    });
    expect(ids(answer.messages)).toEqual(["msg_120", "msg_121"]);
    expect(stub.neverOrderWithCursor).toBe(true);
  });

  it("reports a message that is not in the session", async () => {
    const answer = await readMessages(new MessageStub(longSession()), {
      sessionId: "ses_1",
      around: "msg_999",
    });
    expect(answer.messages).toEqual([]);
    expect(answer.not_found).toContain("not in this session");
  });

  it("shows a message without readable content as a note", async () => {
    const answer = await readMessages(new MessageStub(longSession()), {
      sessionId: "ses_1",
      around: "msg_105",
      before: 1,
      after: 1,
    });
    expect(ids(answer.messages)).toEqual(["msg_104", "msg_105", "msg_106"]);
    expect(answer.messages[1]).toMatchObject({ note: "no readable content" });
  });

  it("keeps the requested message first when the budget is tight", async () => {
    const big = [
      user("msg_1", "before ".repeat(100)),
      user("msg_2", "target ".repeat(100)),
      user("msg_3", "after ".repeat(100)),
    ];
    const answer = await readMessages(new MessageStub(big), {
      sessionId: "ses_1",
      around: "msg_2",
      before: 1,
      after: 1,
      maxChars: 900,
    });
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(900);
    expect(ids(answer.messages)).toContain("msg_2");
    expect(answer.more).toBe(true);
    // Chronological order is kept for what was shown.
    const shown = ids(answer.messages);
    expect([...shown].sort()).toEqual(shown);
  });
});

describe("budget helpers", () => {
  const view = (id: string, textValue: string): MessageView => ({
    id,
    type: "user",
    text: textValue,
    truncated: false,
  });

  it("shrinkView returns the view untouched when it fits and null when nothing fits", () => {
    const small = view("m1", "hi");
    expect(shrinkView(small, 500)).toBe(small);
    expect(shrinkView(view("m2", "x".repeat(1_000)), 20)).toBeNull();
  });

  it("shrinkView drops extra tools first, then cuts the text", () => {
    const tools = Array.from({ length: 8 }, (_, index) => ({
      name: "read",
      status: "completed",
      input_summary: `src/file-${index}.ts`,
    }));
    const full: MessageView = {
      id: "m",
      type: "assistant",
      text: "t".repeat(400),
      tools,
      truncated: false,
    };
    const fewer = shrinkView(full, 700);
    expect(fewer?.tools).toHaveLength(3);
    expect(fewer?.tools_omitted).toBe(5);
    const tight = shrinkView(full, 200);
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(200);
    expect(tight?.truncated).toBe(true);
  });

  it("takeWithinBudget keeps the order and reports what was dropped", () => {
    const views = ["a", "b", "c", "d"].map((id) => view(id, "x".repeat(80)));
    const { kept, dropped } = takeWithinBudget(views, 220);
    expect(ids(kept)).toEqual(["a", "b"]);
    expect(ids(dropped)).toEqual(["c", "d"]);
  });
});
