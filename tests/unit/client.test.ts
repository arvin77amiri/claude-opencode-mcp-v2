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

  it("lists projects, counts sessions and pages sessions without order+cursor", async () => {
    fake = new FakeOpenCode({
      projects: [
        { id: "prj_1", canonical: "C:\\work\\one" },
        { id: "prj_2", canonical: "C:\\work\\two", name: "Two" },
      ],
    });
    for (let index = 1; index <= 5; index += 1) {
      fake.seedSession({ projectID: "prj_1", title: `s${index}`, updated: index * 100 });
    }
    fake.seedSession({ projectID: "prj_2", title: "other", updated: 1 });
    const client = new OpenCodeClient({ baseUrl: await fake.listen() });

    expect((await client.projects()).map((project) => project.id)).toEqual(["prj_1", "prj_2"]);
    expect(await client.sessionCount("prj_1")).toBe(5);

    const first = await client.listSessions({ project: "prj_1", limit: 2, order: "desc" });
    expect(first.data.map((session) => session.title)).toEqual(["s5", "s4"]);
    const cursor = first.cursor?.next;
    expect(cursor).toBeTruthy();
    // `order` together with `cursor` is a 400 on the server: the client must drop it.
    const second = await client.listSessions({
      project: "prj_1",
      limit: 2,
      order: "desc",
      ...(cursor ? { cursor } : {}),
    });
    expect(second.data.map((session) => session.title)).toEqual(["s3", "s2"]);

    const listings = fake.requests.filter((request) => request.path.startsWith("/api/session?"));
    expect(listings[0]?.path).toContain("limit=2");
    expect(listings[0]?.path).toContain("order=desc");
    expect(listings[1]?.path).toContain("cursor=");
    expect(listings[1]?.path).not.toContain("order=");
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
