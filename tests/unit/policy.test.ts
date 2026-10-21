import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SecurityConfigSchema } from "../../src/config/config.js";
import { wildcardToRegExp } from "../../src/security/paths.js";
import { buildPermissions, PROFILE_CAPABILITIES } from "../../src/security/policy.js";

describe("buildPermissions", () => {
  it("keeps read-only profiles fully read-only", () => {
    for (const profile of ["read", "review", "test"] as const) {
      const permissions = buildPermissions(profile, DEFAULT_CONFIG.security);
      expect(permissions.edit).toBe("deny");
      if (profile === "test") {
        expect(permissions.shell).toEqual(expect.objectContaining({ "*": "allow" }));
      } else {
        expect(permissions.shell).toBe("deny");
      }
      expect(permissions.subagent).toBe("deny");
      expect(permissions.question).toBe("deny");
      expect(permissions.external_directory).toBe("deny");
    }
  });

  it("gives coder edit and bash but denies git commit/push", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    expect(permissions.edit).toEqual(expect.objectContaining({ "*": "allow" }));
    const shell = permissions.shell as Record<string, string>;
    expect(shell["*"]).toBe("allow");
    expect(shell["*git*push*"]).toBe("deny");
    expect(shell["*git*commit*"]).toBe("deny");
  });

  it("matches git commit/push anywhere in the command line, like OpenCode does", () => {
    const shell = buildPermissions("code", DEFAULT_CONFIG.security).shell as Record<string, string>;
    // OpenCode evaluates the rules in order and the last matching one wins.
    const effect = (command: string): string => {
      let result = "";
      for (const [pattern, value] of Object.entries(shell)) {
        if (wildcardToRegExp(pattern).test(command)) result = value;
      }
      return result;
    };
    for (const command of [
      "git commit -m x",
      "git add -A && git commit -m x",
      "git -C . commit -m x",
      "git -c user.name=a commit -m x",
      "npm test; git push origin main",
      "cat .env",
      "cat ./config/prod.env",
      "type secrets.pem",
      "cat ~/.ssh/id_rsa",
    ]) {
      expect(effect(command), command).toBe("deny");
    }
    for (const command of ["npm test", "git status", "git diff", "cat .env.example", "ls -la"]) {
      expect(effect(command), command).toBe("allow");
    }
  });

  it("denies grep while sensitive files are protected (grep cannot filter by file)", () => {
    // Regression: grep is authorised by its search pattern only, so it returned
    // the contents of `.env` even though `read` on it was denied.
    expect(buildPermissions("read", DEFAULT_CONFIG.security).grep).toBe("deny");
    const open = SecurityConfigSchema.parse({ protectEnvFiles: false });
    expect(buildPermissions("read", open).grep).toBe("allow");
  });

  it("uses OpenCode 2.x action names (v1 names are silently ignored by the server)", () => {
    // Regression: rules were emitted as `bash` / `task`, which OpenCode 2 never evaluates
    // (it checks `shell` / `subagent`), so shell and subagent restrictions did nothing.
    for (const profile of ["read", "review", "edit", "code", "test"] as const) {
      const keys = Object.keys(buildPermissions(profile, DEFAULT_CONFIG.security));
      expect(keys).toContain("shell");
      expect(keys).toContain("subagent");
      expect(keys).not.toContain("bash");
      expect(keys).not.toContain("task");
    }
  });

  it("denies by default and names execute (code mode) explicitly", () => {
    for (const profile of ["read", "review", "edit", "code", "test"] as const) {
      const permissions = buildPermissions(profile, DEFAULT_CONFIG.security);
      // "*" must come first: later, more specific rules override it (last match wins).
      expect(Object.keys(permissions)[0]).toBe("*");
      expect(permissions["*"]).toBe("deny");
      expect(permissions.execute).toBe("deny");
    }
  });

  it("protects env and credential files by default", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    expect(permissions.read).toEqual(
      expect.objectContaining({ "*.env": "deny", "*.env.*": "deny" }),
    );
    expect(permissions.edit).toEqual(expect.objectContaining({ "*.env": "deny" }));
    expect(permissions.read).toEqual(expect.objectContaining({ "*.env.example": "allow" }));
  });

  it("respects security options", () => {
    const security = SecurityConfigSchema.parse({
      protectEnvFiles: false,
      denyGitPush: false,
      denyGitCommit: false,
      externalDirectory: "allow",
    });
    const permissions = buildPermissions("code", security);
    expect(permissions.read).toBe("allow");
    expect(permissions.external_directory).toBe("allow");
    const shell = permissions.shell as Record<string, string>;
    expect(shell).toEqual({ "*": "allow" });
  });

  it("never emits ask rules (headless bridge)", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    const check = (value: unknown): void => {
      if (value === "ask") throw new Error("ask rule found");
      if (typeof value === "object" && value) {
        for (const nested of Object.values(value)) check(nested);
      }
    };
    check(permissions);
  });
});

describe("profile capabilities", () => {
  it("matches the PRD agent matrix", () => {
    expect(PROFILE_CAPABILITIES.read).toEqual({
      readOnly: true,
      canEdit: false,
      canRunBash: false,
    });
    expect(PROFILE_CAPABILITIES.review).toEqual({
      readOnly: true,
      canEdit: false,
      canRunBash: false,
    });
    expect(PROFILE_CAPABILITIES.code).toEqual({ readOnly: false, canEdit: true, canRunBash: true });
    expect(PROFILE_CAPABILITIES.test).toEqual({ readOnly: true, canEdit: false, canRunBash: true });
  });
});
