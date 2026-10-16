import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import {
  fetchHealth,
  OpenCodeApiError,
  OpenCodeClient,
  parseSseBlock,
} from "../../src/opencode/client.js";
import { FakeOpenCode } from "../helpers/fake-opencode.js";

let fake: FakeOpenCode | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("OpenCodeClient", () => {
  it("reads server info and wraps data envelopes", async () => {
    fake = new FakeOpenCode({ version: "2.0.22" });
    const client = new OpenCodeClient({ baseUrl: await fake.listen() });
    expect((await client.info()).version).toBe("2.0.22");
    expect(await fetchHealth(client.baseUrl)).toEqual({ healthy: true, version: "2.0.22" });
  });

  it("rejects HTML answers served with HTTP 200 (v1 routes on OpenCode 2)", async () => {
    fake = new FakeOpenCode();
    const client = new OpenCodeClient({ baseUrl: await fake.listen() });
    await expect(client.request("GET", "/session")).rejects.toMatchObject({
      code: "OPENCODE_ERROR",
    });
    await expect(client.request("GET", "/global/health")).rejects.toBeInstanceOf(BridgeError);
  });

  it("sends Basic auth with user opencode and maps 401", async () => {
    fake = new FakeOpenCode({ password: "s3cret" });
    const url = await fake.listen();
    const ok = new OpenCodeClient({
      baseUrl: url,
      auth: { username: "opencode", password: "s3cret" },
    });
    expect((await ok.info()).version).toBeTruthy();
    expect(fake.authHeaders.at(-1)).toBe(
      `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`,
    );

    const bad = new OpenCodeClient({ baseUrl: url });
    await expect(bad.info()).rejects.toMatchObject({ code: "OPENCODE_UNAVAILABLE" });
    expect(await fetchHealth(url)).toBeNull();
  });

  it("throws OpenCodeApiError with the typed body on 404", async () => {
    fake = new FakeOpenCode();
    const client = new OpenCodeClient({ baseUrl: await fake.listen() });
    const error = await client.getSession("ses_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeApiError);
    expect((error as OpenCodeApiError).status).toBe(404);
    expect(await client.agent("nope")).toBeNull();
  });

  it("streams parsed SSE events", async () => {
    fake = new FakeOpenCode();
    const client = new OpenCodeClient({ baseUrl: await fake.listen() });
    const controller = new AbortController();
    const events = await client.openEvents(controller.signal);
    const first = await events.next();
    expect(first.value).toMatchObject({ type: "server.connected" });
    fake.emit("session.execution.started", { sessionID: "ses_1" });
    const second = await events.next();
    expect(second.value).toMatchObject({
      type: "session.execution.started",
      data: { sessionID: "ses_1" },
    });
    controller.abort();
  });
});

describe("parseSseBlock", () => {
  it("parses data lines and ignores heartbeats", () => {
    expect(parseSseBlock(": heartbeat")).toBeNull();
    expect(parseSseBlock('data: {"type":"x.y","data":{"a":1}}')).toEqual({
      type: "x.y",
      data: { a: 1 },
    });
    expect(parseSseBlock("data: not-json")).toBeNull();
  });
});
