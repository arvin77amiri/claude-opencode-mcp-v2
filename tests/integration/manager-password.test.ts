import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { createLogger } from "../../src/util/logger.js";

const SERVE_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "helpers",
  "fake-opencode-serve.mjs",
);

const tempDirs: string[] = [];
const managers: OpenCodeManager[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-password-"));
  tempDirs.push(dir);
  return dir;
}

/** Launcher that behaves like an `opencode` executable: a .cmd shim on Windows, a sh script elsewhere. */
async function makeLauncher(dir: string): Promise<string> {
  const node = process.execPath;
  if (process.platform === "win32") {
    const launcher = path.join(dir, "fake-opencode.cmd");
    await fs.promises.writeFile(launcher, `@"${node}" "${SERVE_SCRIPT}" %*\r\n`, "utf8");
    return launcher;
  }
  const launcher = path.join(dir, "fake-opencode");
  await fs.promises.writeFile(
    launcher,
    `#!/bin/sh\nexec "${node}" "${SERVE_SCRIPT}" "$@"\n`,
    "utf8",
  );
  await fs.promises.chmod(launcher, 0o755);
  return launcher;
}

async function startManager(env: NodeJS.ProcessEnv) {
  const dir = await tempDir();
  const report = path.join(dir, "report.json");
  const binary = await makeLauncher(dir);
  const config = BridgeConfigSchema.parse({
    opencode: { binary, autoStart: true, startupTimeout: 15_000 },
  });
  const manager = new OpenCodeManager({
    logger: createLogger({ level: "silent" }),
    env: { ...env, FAKE_OPENCODE_REPORT: report },
  });
  managers.push(manager);
  const key = await manager.ensure({ cwd: os.tmpdir(), config, agentConfig: {} });
  const received = JSON.parse(await fs.promises.readFile(report, "utf8")) as {
    pid: number;
    username: string | null;
    password: string | null;
  };
  return { manager, key, received };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
      ),
  );
});

describe("OpenCodeManager server credentials", () => {
  it("generates a password for the spawned server when none is configured", async () => {
    // Regression: OpenCode 2 `serve` always requires auth; without a password
    // handed in through the environment it invents one and answers 401 to the
    // bridge, so the server never became healthy.
    const { manager, received } = await startManager({
      ...process.env,
      OPENCODE_SERVER_PASSWORD: undefined,
      OPENCODE_SERVER_USERNAME: undefined,
    });

    expect(received.username).toBe("opencode");
    expect(received.password).toBeTruthy();
    expect((received.password ?? "").length).toBeGreaterThanOrEqual(24);
    expect(manager.getStatus()).toHaveLength(1);
    expect(manager.existingClient()).not.toBeNull();
  });

  it("generates a different password for every spawned server", async () => {
    const env = { ...process.env, OPENCODE_SERVER_PASSWORD: undefined };
    const first = await startManager(env);
    const second = await startManager(env);
    expect(first.received.password).not.toBe(second.received.password);
  });

  it("uses the configured password instead of generating one", async () => {
    const { received } = await startManager({
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "user-chosen-secret",
    });
    expect(received.password).toBe("user-chosen-secret");
  });
});

describe("OpenCodeManager shutdown", () => {
  it("stopAll kills the real server even behind a shell shim", async () => {
    // Regression: on Windows `opencode.cmd` runs the server under cmd.exe; killing
    // only the shell left the server orphaned and the bridge process hanging.
    const { manager, received } = await startManager({
      ...process.env,
      OPENCODE_SERVER_PASSWORD: undefined,
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(received.pid)).toBe(true);
    await manager.stopAll();
    const deadline = Date.now() + 5000;
    while (alive(received.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive(received.pid)).toBe(false);
  });
});
