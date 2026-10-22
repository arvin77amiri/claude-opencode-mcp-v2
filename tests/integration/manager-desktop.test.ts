import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode } from "../helpers/fake-opencode.js";

const fakes: FakeOpenCode[] = [];
const managers: OpenCodeManager[] = [];
const tempDirs: string[] = [];

async function startFake(password: string): Promise<{ fake: FakeOpenCode; url: string }> {
  const fake = new FakeOpenCode({ password });
  fakes.push(fake);
  return { fake, url: await fake.listen() };
}

function serviceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-desktop-mgr-"));
  tempDirs.push(dir);
  return dir;
}

function writeService(file: string, fields: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify({ id: "svc", version: "2.1.2", ...fields }), "utf8");
}

function desktopConfig(serviceFile: string, extra: Record<string, unknown> = {}) {
  return BridgeConfigSchema.parse({
    // autoStart + a bogus binary: if desktop mode ever fell back to spawning, the error
    // code would be OPENCODE_NOT_AVAILABLE instead of OPENCODE_UNAVAILABLE.
    opencode: {
      desktop: true,
      serviceFile,
      autoStart: true,
      binary: path.join(os.tmpdir(), "no-such-opencode"),
      ...extra,
    },
  });
}

function newManager(): OpenCodeManager {
  const manager = new OpenCodeManager({ logger: createLogger({ level: "silent" }), env: {} });
  managers.push(manager);
  return manager;
}

const ensure = (manager: OpenCodeManager, config: ReturnType<typeof desktopConfig>) =>
  manager.ensure({ cwd: os.tmpdir(), config, agentConfig: {} });

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OpenCodeManager desktop mode", () => {
  it("connects with the url and password from service.json", async () => {
    const { fake, url } = await startFake("pw-1");
    const file = path.join(serviceDir(), "service.json");
    writeService(file, { url, pid: process.pid, password: "pw-1" });
    const manager = newManager();

    await ensure(manager, desktopConfig(file));

    expect(manager.getStatus()).toMatchObject([{ url, external: true }]);
    expect(fake.authHeaders.at(-1)).toBe(
      `Basic ${Buffer.from("opencode:pw-1").toString("base64")}`,
    );
  });

  it("takes precedence over a static opencode.url", async () => {
    const { url } = await startFake("pw-1");
    const file = path.join(serviceDir(), "service.json");
    writeService(file, { url, pid: process.pid, password: "pw-1" });
    const manager = newManager();

    await ensure(manager, desktopConfig(file, { url: "http://127.0.0.1:1" }));

    expect(manager.getStatus()[0]?.url).toBe(url);
  });

  it("reconnects when the app restarts with a new port and password", async () => {
    const first = await startFake("pw-1");
    const file = path.join(serviceDir(), "service.json");
    writeService(file, { url: first.url, pid: process.pid, password: "pw-1" });
    const manager = newManager();
    const config = desktopConfig(file);
    await ensure(manager, config);

    await first.fake.close();
    const second = await startFake("pw-2");
    writeService(file, { url: second.url, pid: process.pid, password: "pw-2" });
    await ensure(manager, config);

    expect(manager.getStatus()[0]?.url).toBe(second.url);
  });

  it("fails clearly and never spawns an engine when the app is closed", async () => {
    const file = path.join(serviceDir(), "service.json");
    const pid = spawnSync(process.execPath, ["-e", ""]).pid as number;
    writeService(file, { url: "http://127.0.0.1:9", pid, password: "pw-1" });
    const manager = newManager();

    await expect(ensure(manager, desktopConfig(file))).rejects.toMatchObject({
      code: "OPENCODE_UNAVAILABLE",
      message: expect.stringMatching(/not running/),
    });
    expect(manager.getStatus()).toEqual([]);
  });

  it("drops a live connection once the app is closed", async () => {
    const { url } = await startFake("pw-1");
    const file = path.join(serviceDir(), "service.json");
    writeService(file, { url, pid: process.pid, password: "pw-1" });
    const manager = newManager();
    const config = desktopConfig(file);
    await ensure(manager, config);

    fs.rmSync(file);

    await expect(ensure(manager, config)).rejects.toMatchObject({ code: "OPENCODE_UNAVAILABLE" });
    expect(manager.getStatus()).toEqual([]);
  });
});
