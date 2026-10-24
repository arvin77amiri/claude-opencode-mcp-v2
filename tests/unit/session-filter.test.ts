import { describe, expect, it } from "vitest";
import {
  type CompactMessage,
  clip,
  DEFAULT_FILTER_LIMITS,
  describeError,
  extractChangedFiles,
  findContentMatch,
  normalizeMessage,
  normalizeMessages,
  summarizeToolInput,
} from "../../src/opencode/session-filter.js";

const BASE64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(50);

function tool(name: string, state: Record<string, unknown>) {
  return { type: "tool", id: `call_${name}`, name, state, time: { created: 1 } };
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "msg_a1",
    type: "assistant",
    agent: "coder",
    time: { created: 10 },
    content,
    finish: "stop",
    ...extra,
  };
}

describe("clip", () => {
  it("leaves short text alone and marks how much was cut", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("abcdefghij", 4)).toBe("abcd [truncated 6 chars]");
  });
});

describe("normalizeMessage", () => {
  it("keeps user text and file names but never the base64 data", () => {
    const compact = normalizeMessage({
      id: "msg_u1",
      type: "user",
      time: { created: 5 },
      text: "please fix the parser",
      files: [{ name: "log.txt", mime: "text/plain", data: BASE64, source: { type: "file" } }],
    });
    expect(compact).toEqual({
      id: "msg_u1",
      type: "user",
      at: 5,
      text: "please fix the parser",
      files: ["log.txt"],
    });
    expect(JSON.stringify(compact)).not.toContain("QUJDRE");
  });

  it("keeps assistant text and drops reasoning and tool output", () => {
    const compact = normalizeMessage(
      assistant([
        { type: "reasoning", text: "SECRET-REASONING step by step" },
        tool("read", {
          status: "completed",
          input: { path: "src/a.ts" },
          content: [{ type: "text", text: "SECRET-OUTPUT line 1\nline 2" }],
        }),
        { type: "text", text: "I fixed it." },
      ]),
    );
    const json = JSON.stringify(compact);
    expect(json).not.toContain("SECRET-REASONING");
    expect(json).not.toContain("SECRET-OUTPUT");
    expect(compact).toMatchObject({
      type: "assistant",
      agent: "coder",
      finish: "stop",
      text: "I fixed it.",
      tools: [{ name: "read", status: "completed", input: "src/a.ts" }],
    });
  });

  it("summarizes tool inputs as path or command only", () => {
    const fileContent = "export const secret = 1;\n".repeat(200);
    const compact = normalizeMessage(
      assistant([
        tool("write", { status: "completed", input: { path: "src/new.ts", content: fileContent } }),
        tool("edit", { status: "completed", input: { filePath: "src/b.ts", oldString: "x" } }),
        tool("shell", { status: "completed", input: { command: "npm test -- --run" } }),
        tool("execute", { status: "completed", input: { command: "ls", cwd: "/tmp" } }),
        tool("skill", { status: "completed", input: { name: "pdf" } }),
        tool("mystery", { status: "running", input: { blob: "zzz" } }),
      ]),
    );
    expect(JSON.stringify(compact)).not.toContain("secret");
    expect(compact).toMatchObject({
      tools: [
        { name: "write", input: "src/new.ts" },
        { name: "edit", input: "src/b.ts" },
        { name: "shell", input: "npm test -- --run" },
        { name: "execute", input: "ls" },
        { name: "skill", input: "pdf" },
        { name: "mystery", status: "running" },
      ],
    });
    const last = (compact as { tools: Array<{ input?: string }> }).tools[5];
    expect(last?.input).toBeUndefined();
  });

  it("reports failed tool calls with their error", () => {
    const compact = normalizeMessage(
      assistant([
        tool("shell", {
          status: "error",
          input: { command: "npm run build" },
          error: { type: "ToolFailed", message: "exit code 2" },
          content: [{ type: "text", text: "HUGE-OUTPUT" }],
        }),
      ]),
    );
    expect(compact).toMatchObject({
      tools: [{ name: "shell", status: "error", error: "ToolFailed: exit code 2" }],
    });
    expect(JSON.stringify(compact)).not.toContain("HUGE-OUTPUT");
  });

  it("keeps assistant errors in both the structured and the legacy shape", () => {
    expect(
      normalizeMessage(
        assistant([], {
          finish: "error",
          error: { type: "ProviderError", status: 429, message: "Free usage limit reached" },
        }),
      ),
    ).toMatchObject({
      finish: "error",
      error: { type: "ProviderError", status: 429, message: "Free usage limit reached" },
    });
    expect(
      normalizeMessage(
        assistant([], {
          finish: "error",
          error: { name: "APIError", data: { message: "bad key" } },
        }),
      ),
    ).toMatchObject({ error: { type: "APIError", message: "bad key" } });
  });

  it("keeps compaction summaries and failed outcomes, drops running compactions", () => {
    expect(
      normalizeMessage({
        id: "msg_c1",
        type: "compaction",
        status: "completed",
        summary: "Goal: fix parser. Done: tokenizer.",
        recent: "RECENT-RAW",
        time: { created: 7 },
      }),
    ).toEqual({
      id: "msg_c1",
      type: "compaction",
      at: 7,
      summary: "Goal: fix parser. Done: tokenizer.",
    });
    expect(
      normalizeMessage({
        id: "msg_c2",
        type: "compaction",
        status: "running",
        time: { created: 1 },
      }),
    ).toBeNull();
    expect(
      normalizeMessage({
        id: "msg_c3",
        type: "compaction",
        status: "failed",
        time: { created: 1 },
      }),
    ).toMatchObject({ type: "compaction", failed: true });
  });

  it("drops the system prompt and bookkeeping messages", () => {
    for (const type of ["system", "synthetic", "skill", "agent-switched", "model-switched"]) {
      expect(
        normalizeMessage({
          id: "msg_x",
          type,
          text: "SYSTEM PROMPT ".repeat(100),
          time: { created: 1 },
        }),
      ).toBeNull();
    }
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage({ type: "user", text: "no id" })).toBeNull();
  });

  it("keeps the shell command and exit code but not its output", () => {
    const compact = normalizeMessage({
      id: "msg_s1",
      type: "shell",
      shellID: "sh_1",
      command: "git status",
      status: "exited",
      exit: 0,
      output: { output: "SHELL-OUTPUT", cursor: 0, size: 12, truncated: false },
      time: { created: 3 },
    });
    expect(compact).toEqual({
      id: "msg_s1",
      type: "shell",
      at: 3,
      command: "git status",
      status: "exited",
      exit: 0,
    });
  });

  it("keeps the failure of an idle message (live shape, not in the OpenAPI schema)", () => {
    expect(
      normalizeMessage({
        id: "msg_i1",
        type: "idle",
        outcome: "failed",
        error: { type: "ProviderError", message: "overloaded" },
        time: { created: 9 },
      }),
    ).toEqual({
      id: "msg_i1",
      type: "idle",
      at: 9,
      outcome: "failed",
      error: { type: "ProviderError", message: "overloaded" },
    });
  });

  it("truncates each field with a visible marker", () => {
    const long = "x".repeat(DEFAULT_FILTER_LIMITS.textChars + 123);
    const compact = normalizeMessage({
      id: "msg_u2",
      type: "user",
      text: long,
      time: { created: 1 },
    }) as Extract<CompactMessage, { type: "user" }>;
    expect(compact.text.endsWith("[truncated 123 chars]")).toBe(true);
    expect(compact.text.length).toBeLessThan(long.length);

    const shell = normalizeMessage({
      id: "msg_s2",
      type: "shell",
      command: `echo ${"y".repeat(500)}`,
      status: "exited",
      time: { created: 1 },
    }) as Extract<CompactMessage, { type: "shell" }>;
    expect(shell.command).toMatch(/\[truncated \d+ chars\]$/);
  });

  it("shrinks a tool-heavy session to a small fraction of its raw size", () => {
    const raw = [
      { id: "msg_u", type: "user", text: "do it", time: { created: 1 } },
      ...Array.from({ length: 20 }, (_, index) =>
        assistant(
          [
            { type: "reasoning", text: "r".repeat(2_000) },
            tool("read", {
              status: "completed",
              input: { path: `src/f${index}.ts` },
              content: [{ type: "text", text: "o".repeat(5_000) }],
            }),
          ],
          { id: `msg_a${index}` },
        ),
      ),
    ];
    const compact = normalizeMessages(raw);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(raw).length / 20);
    expect(compact).toHaveLength(21);
  });
});

describe("summarizeToolInput / describeError", () => {
  it("returns nothing for inputs without a path or command", () => {
    expect(summarizeToolInput("grep", { pattern: "foo" })).toBeUndefined();
    expect(summarizeToolInput("read", "not an object")).toBeUndefined();
  });

  it("collapses whitespace in commands and handles strings", () => {
    expect(summarizeToolInput("shell", { command: "a\n  b" })).toBe("a b");
    expect(describeError("  boom  ")).toEqual({ message: "boom" });
    expect(describeError({})).toBeUndefined();
    expect(describeError(42)).toBeUndefined();
  });
});

describe("extractChangedFiles", () => {
  it("lists files from write and edit inputs once, in order", () => {
    const messages = [
      assistant([
        tool("write", { status: "completed", input: { path: "src/a.ts", content: "..." } }),
        tool("read", { status: "completed", input: { path: "src/never.ts" } }),
        tool("edit", { status: "completed", input: { filePath: "src/b.ts" } }),
      ]),
      assistant(
        [
          tool("edit", { status: "completed", input: { path: "src/a.ts" } }),
          tool("Write", { status: "completed", input: { file_path: "docs/c.md" } }),
          tool("shell", { status: "completed", input: { command: "echo > ignored.txt" } }),
        ],
        { id: "msg_a2" },
      ),
    ];
    expect(extractChangedFiles(messages)).toEqual(["src/a.ts", "src/b.ts", "docs/c.md"]);
  });

  it("skips calls that failed and malformed input", () => {
    expect(
      extractChangedFiles([
        assistant([
          tool("write", { status: "error", input: { path: "src/failed.ts" } }),
          tool("edit", { status: "completed" }),
          tool("edit", { status: "completed", input: { nothing: true } }),
        ]),
        { id: "msg_u", type: "user", text: "write src/user.ts" },
        null,
      ]),
    ).toEqual([]);
  });
});

describe("findContentMatch", () => {
  const messages = normalizeMessages([
    {
      id: "msg_u1",
      type: "user",
      text: "Why does the Tokenizer drop unicode?",
      time: { created: 1 },
    },
    assistant(
      [
        { type: "reasoning", text: "zebra hidden in reasoning" },
        tool("read", {
          status: "completed",
          input: { path: "src/tokenizer.ts" },
          content: [{ type: "text", text: "zebra hidden in tool output" }],
        }),
        { type: "text", text: "The tokenizer strips non-ASCII bytes in normalize()." },
      ],
      { id: "msg_a1" },
    ),
    {
      id: "msg_c1",
      type: "compaction",
      status: "completed",
      summary: "Fixed the tokenizer; remaining: docs.",
      time: { created: 3 },
    },
  ]);

  it("matches case-insensitively when every word is present in one message", () => {
    const match = findContentMatch(messages, "TOKENIZER unicode");
    expect(match?.messageIds).toEqual(["msg_u1"]);
    expect(findContentMatch(messages, "tokenizer")?.messageIds).toEqual([
      "msg_u1",
      "msg_a1",
      "msg_c1",
    ]);
    expect(findContentMatch(messages, "tokenizer docs")?.messageIds).toEqual(["msg_c1"]);
  });

  it("only searches the filtered text", () => {
    expect(findContentMatch(messages, "zebra")).toBeNull();
    expect(findContentMatch(messages, "   ")).toBeNull();
    expect(findContentMatch(messages, "absent")).toBeNull();
  });

  it("searches tool paths and error text", () => {
    expect(findContentMatch(messages, "src/tokenizer.ts")?.messageIds).toEqual(["msg_a1"]);
    const failed = normalizeMessages([
      assistant([], {
        id: "msg_e",
        finish: "error",
        error: { type: "ProviderError", message: "rate limited" },
      }),
    ]);
    expect(findContentMatch(failed, "rate limited")?.messageIds).toEqual(["msg_e"]);
  });

  it("returns a bounded one-line snippet around the first hit and at most 5 ids", () => {
    const long = `${"intro ".repeat(80)}NEEDLE ${"outro ".repeat(80)}`;
    const many = normalizeMessages(
      Array.from({ length: 9 }, (_, index) => ({
        id: `msg_${index}`,
        type: "user",
        text: `${long}\n${index}`,
        time: { created: index },
      })),
    );
    const match = findContentMatch(many, "needle", { snippetChars: 200 });
    expect(match?.messageIds).toHaveLength(5);
    expect(match?.snippet.length).toBeLessThanOrEqual(200);
    expect(match?.snippet).toContain("NEEDLE");
    expect(match?.snippet).not.toContain("\n");
    expect(match?.snippet.startsWith("…")).toBe(true);
    expect(match?.snippet.endsWith("…")).toBe(true);
  });
});
