import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import {
  desktopServiceFile,
  isPidAlive,
  readDesktopService,
  serviceFingerprint,
} from "../../src/opencode/desktop-service.js";

const SECRET = "s3cret-desktop-password";
const tempDirs: string[] = [];

function tempFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-desktop-"));
  tempDirs.push(dir);
  const file = path.join(dir, "service.json");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid as number;
}

function catchError(fn: () => unknown): BridgeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    return error as BridgeError;
  }
  throw new Error("expected an error");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("desktop service discovery", () => {
  it("defaults to ~/.local/state and honours XDG_STATE_HOME", () => {
    expect(desktopServiceFile({})).toBe(
      path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
    );
    expect(desktopServiceFile({ XDG_STATE_HOME: "/x/state" })).toBe(
      path.join("/x/state", "opencode", "service.json"),
    );
  });

  it("reads url, pid and credentials of a running service", () => {
    const file = tempFile(
      JSON.stringify({
        id: "abc",
        version: "2.1.2",
        url: "http://127.0.0.1:45278",
        pid: process.pid,
        password: SECRET,
      }),
    );
    const service = readDesktopService({ file });
    expect(service).toMatchObject({
      url: "http://127.0.0.1:45278",
      pid: process.pid,
      version: "2.1.2",
      id: "abc",
      auth: { username: "opencode", password: SECRET },
    });
  });

  it("accepts a UTF-8 BOM (files written by Windows tools)", () => {
    const file = tempFile(`﻿${JSON.stringify({ url: "http://127.0.0.1:1", pid: process.pid })}`);
    expect(readDesktopService({ file }).auth).toBeNull();
  });

  it("reports a missing file as the app not running", () => {
    const error = catchError(() =>
      readDesktopService({ file: path.join(os.tmpdir(), "nope", "service.json") }),
    );
    expect(error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(error.message).toMatch(/Open OpenCode Desktop/);
  });

  it("reports a stale file (dead pid) without leaking the password", () => {
    const pid = deadPid();
    const file = tempFile(JSON.stringify({ url: "http://127.0.0.1:2", pid, password: SECRET }));
    const error = catchError(() => readDesktopService({ file }));
    expect(error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(error.message).toContain(`pid ${pid}`);
    expect(JSON.stringify({ m: error.message, d: error.details })).not.toContain(SECRET);
  });

  it("rejects invalid JSON and files without url/pid", () => {
    expect(catchError(() => readDesktopService({ file: tempFile("{not json") })).code).toBe(
      "OPENCODE_UNAVAILABLE",
    );
    const error = catchError(() =>
      readDesktopService({ file: tempFile(JSON.stringify({ password: SECRET })) }),
    );
    expect(error.message).toMatch(/no usable url\/pid/);
    expect(JSON.stringify(error.details)).not.toContain(SECRET);
  });

  it("detects live and dead pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it("fingerprints an app instance without embedding the password", () => {
    const base = { file: "f", url: "http://h:1", pid: 1, version: null, id: "a" };
    const a = serviceFingerprint({ ...base, auth: { username: "opencode", password: SECRET } });
    const b = serviceFingerprint({ ...base, auth: { username: "opencode", password: "other" } });
    expect(a).not.toBe(b);
    expect(a).not.toContain(SECRET);
  });
});
