import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import { EditorLocks } from "../../src/mcp/editor-locks.js";

const root = path.join(os.tmpdir(), "co-locks");

describe("EditorLocks", () => {
  it("refuses a second editor on the same, a parent or a child directory", () => {
    const locks = new EditorLocks();
    locks.acquire(path.join(root, "app"), "ses_1");
    for (const cwd of [path.join(root, "app"), root, path.join(root, "app", "src")]) {
      let error: unknown;
      try {
        locks.acquire(cwd, "ses_2");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("WORKSPACE_BUSY");
      expect((error as BridgeError).details?.busy_session_id).toBe("ses_1");
      expect((error as BridgeError).retryable).toBe(true);
    }
  });

  it("allows sibling directories and frees the workspace on release", () => {
    const locks = new EditorLocks();
    const release = locks.acquire(path.join(root, "app"), "ses_1");
    expect(() => locks.acquire(path.join(root, "app-other"), "ses_2")).not.toThrow();
    release();
    expect(locks.holder(path.join(root, "app"))).toBeNull();
    expect(() => locks.acquire(path.join(root, "app"), "ses_3")).not.toThrow();
  });
});
