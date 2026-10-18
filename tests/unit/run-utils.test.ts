import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { BridgeError, serializeError } from "../../src/errors.js";
import type { AssistantMessage } from "../../src/opencode/api-types.js";
import {
  addUsage,
  describeError,
  parseModelRef,
  resolveModel,
  sumUsage,
} from "../../src/opencode/run.js";
import { createSessionRecord, SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    expect(parseModelRef("deepseek/deepseek-v4-pro", "deepseek")).toEqual({
      providerID: "deepseek",
      id: "deepseek-v4-pro",
    });
  });

  it("prefixes bare model ids", () => {
    expect(parseModelRef("deepseek-v4-pro", "deepseek")).toEqual({
      providerID: "deepseek",
      id: "deepseek-v4-pro",
    });
  });

  it("rejects empty values", () => {
    expect(() => parseModelRef("  ", "deepseek")).toThrowError(BridgeError);
  });
});

describe("resolveModel", () => {
  const fakeClient = (
    models: Array<{ id: string; providerID: string }>,
    defaultModel: { id: string; providerID: string } | null = models[0] ?? null,
  ) =>
    ({
      defaultModel: vi.fn(async () => defaultModel),
      models: vi.fn(async () => models),
    }) as never;

  it("uses the explicit request first", async () => {
    const model = await resolveModel(fakeClient([]), DEFAULT_CONFIG, "deepseek/deepseek-v4-pro");
    expect(model).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro" });
  });

  it("uses config defaults.model second", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, model: "deepseek/deepseek-flash" },
    };
    const model = await resolveModel(fakeClient([]), config);
    expect(model).toEqual({ providerID: "deepseek", id: "deepseek-flash" });
  });

  it("uses the server default when it belongs to the configured provider", async () => {
    const model = await resolveModel(
      fakeClient([{ id: "deepseek-v4-pro", providerID: "deepseek" }]),
      DEFAULT_CONFIG,
    );
    expect(model).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro" });
  });

  it("never assumes a provider: the user's own server default wins", async () => {
    const model = await resolveModel(
      fakeClient(
        [
          { id: "free", providerID: "opencode" },
          { id: "deepseek-flash", providerID: "deepseek" },
        ],
        { id: "free", providerID: "opencode" },
      ),
      DEFAULT_CONFIG,
    );
    expect(model).toEqual({ providerID: "opencode", id: "free" });
  });

  it("waits for the server default model during the OpenCode startup warm-up", async () => {
    // Regression: the very first call after startup got "no default model" because
    // OpenCode 2 reports none for ~1 s while its providers load.
    const defaultModel = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "free", providerID: "opencode" });
    const client = { defaultModel, models: vi.fn(async () => []) } as never;
    expect(await resolveModel(client, DEFAULT_CONFIG)).toEqual({
      providerID: "opencode",
      id: "free",
    });
    expect(defaultModel).toHaveBeenCalledTimes(3);
  });

  it("gives up when the server never reports a default model", async () => {
    await expect(
      resolveModel(fakeClient([], null), DEFAULT_CONFIG, undefined, 400),
    ).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
  });

  it("looks a bare model id up in the catalog when no provider is configured", async () => {
    const client = fakeClient([
      { id: "glm5.3-flash", providerID: "nan" },
      { id: "other", providerID: "litellm" },
    ]);
    expect(await resolveModel(client, DEFAULT_CONFIG, "glm5.3-flash")).toEqual({
      providerID: "nan",
      id: "glm5.3-flash",
    });
  });

  it("rejects ambiguous or unknown bare model ids", async () => {
    const client = fakeClient([
      { id: "flash", providerID: "nan" },
      { id: "flash", providerID: "litellm" },
    ]);
    await expect(resolveModel(client, DEFAULT_CONFIG, "flash")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(resolveModel(client, DEFAULT_CONFIG, "nope")).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
    });
  });

  it("rejects a bare id in parseModelRef without a provider", () => {
    expect(() => parseModelRef("flash", null)).toThrowError(/no provider/);
  });

  it("falls back to the server default model", async () => {
    const model = await resolveModel(
      fakeClient([{ id: "free", providerID: "opencode" }]),
      DEFAULT_CONFIG,
    );
    expect(model).toEqual({ providerID: "opencode", id: "free" });
  });

  it("errors when nothing is available", async () => {
    await expect(resolveModel(fakeClient([], null), DEFAULT_CONFIG)).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
    });
  });
});

describe("describeError", () => {
  it("maps provider auth errors", () => {
    const mapped = describeError({
      name: "ProviderAuthError",
      data: { providerID: "deepseek", message: "bad key" },
    });
    expect(mapped.code).toBe("OPENCODE_ERROR");
    expect(mapped.message).toContain("deepseek");
  });

  it("accepts plain-string and message-only errors", () => {
    expect(describeError("boom")).toMatchObject({
      code: "AGENT_EXECUTION_FAILED",
      message: "boom",
    });
    expect(describeError({ message: "bad" }).message).toBe("bad");
  });

  it("maps aborted messages", () => {
    expect(describeError({ name: "MessageAbortedError", data: {} }).code).toBe("AGENT_ABORTED");
  });

  it("maps API errors with status details", () => {
    const mapped = describeError({
      name: "APIError",
      data: { message: "rate limited", statusCode: 429, isRetryable: true },
    });
    expect(mapped.code).toBe("AGENT_EXECUTION_FAILED");
    expect(mapped.details?.statusCode).toBe(429);
  });
});

describe("SessionRegistry", () => {
  it("persists and reloads sessions", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const logger = createLogger({ level: "silent" });
    const registry = new SessionRegistry(file, logger);
    registry.upsert(
      createSessionRecord({
        id: "ses_1",
        cwd: "/tmp",
        agent: "coder",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        title: "test",
      }),
    );

    const reloaded = new SessionRegistry(file, logger);
    expect(reloaded.get("ses_1")?.agent).toBe("coder");
    expect(reloaded.update("ses_1", { status: "completed" })?.status).toBe("completed");
    expect(reloaded.list()).toHaveLength(1);

    if (process.platform !== "win32") {
      const mode = (await fs.promises.stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("prunes sessions older than the retention window", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const old = createSessionRecord({
      id: "ses_old",
      cwd: "/tmp",
      agent: "coder",
      provider: "deepseek",
      model: null,
      title: null,
    });
    old.updatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, sessions: [old] }));
    const registry = new SessionRegistry(file, createLogger({ level: "silent" }));
    expect(registry.get("ses_old")).toBeNull();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("merges sessions written by another bridge process (no clobbering)", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const logger = createLogger({ level: "silent" });
    const processA = new SessionRegistry(file, logger);
    const processB = new SessionRegistry(file, logger);

    processA.upsert(
      createSessionRecord({
        id: "ses_a",
        cwd: "/tmp",
        agent: "coder",
        provider: "deepseek",
        model: null,
        title: null,
      }),
    );
    processB.upsert(
      createSessionRecord({
        id: "ses_b",
        cwd: "/tmp",
        agent: "reviewer",
        provider: "deepseek",
        model: null,
        title: null,
      }),
    );

    const reloaded = new SessionRegistry(file, logger);
    expect(reloaded.get("ses_a")).not.toBeNull();
    expect(reloaded.get("ses_b")).not.toBeNull();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("marks stale running sessions as failed on load", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const stale = createSessionRecord({
      id: "ses_stale",
      cwd: "/tmp",
      agent: "coder",
      provider: "deepseek",
      model: null,
      title: null,
    });
    stale.status = "running";
    stale.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, sessions: [stale] }));

    const registry = new SessionRegistry(file, createLogger({ level: "silent" }));
    const session = registry.get("ses_stale");
    expect(session?.status).toBe("failed");
    expect(session?.lastError?.code).toBe("BRIDGE_RESTARTED");
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe("sumUsage / addUsage", () => {
  const assistant = (extra: Partial<AssistantMessage>): AssistantMessage => ({
    id: "msg_1",
    type: "assistant",
    time: { created: 0 },
    ...extra,
  });

  it("adds up cost and tokens over assistant messages", () => {
    const usage = sumUsage([
      assistant({
        cost: 0.01,
        tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } },
      }),
      assistant({ cost: 0.02, tokens: { input: 200, output: 20, reasoning: 0 } }),
      assistant({}),
    ]);
    expect(usage).toEqual({
      cost: 0.03,
      input_tokens: 300,
      output_tokens: 30,
      reasoning_tokens: 5,
      cache_read_tokens: 50,
      cache_write_tokens: 0,
    });
  });

  it("is undefined when no message reports usage", () => {
    expect(sumUsage([assistant({})])).toBeUndefined();
    expect(sumUsage([])).toBeUndefined();
  });

  it("accumulates across runs", () => {
    const one = sumUsage([assistant({ cost: 1, tokens: { input: 1, output: 2 } })]);
    expect(addUsage(undefined, one)).toEqual(one);
    expect(addUsage(one, undefined)).toEqual(one);
    expect(addUsage(one, one)?.output_tokens).toBe(4);
    expect(addUsage(one, one)?.cost).toBe(2);
  });
});

describe("serializeError", () => {
  it("serializes BridgeError with code", () => {
    const serialized = serializeError(
      new BridgeError("INVALID_PATH", "nope", { details: { x: 1 } }),
      "req_1",
    );
    expect(serialized).toEqual({
      code: "INVALID_PATH",
      message: "nope",
      details: { x: 1 },
      retryable: false,
      request_id: "req_1",
    });
  });

  it("wraps unknown errors", () => {
    expect(serializeError(new Error("boom")).code).toBe("INTERNAL_ERROR");
  });
});
