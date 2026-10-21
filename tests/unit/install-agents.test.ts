import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { GENERATED_MARKER, runInstallAgents } from "../../src/cli/install-agents.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-agents-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const env = (home: string): NodeJS.ProcessEnv => ({ XDG_CONFIG_HOME: path.join(home, "cfg") });

function frontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const end = text.indexOf("\n---", 4);
  return parseYaml(text.slice(4, end)) as Record<string, unknown>;
}

describe("install-agents", () => {
  it("writes v2 agent files with permissions and no legacy fields", async () => {
    const project = tmp();
    expect(await runInstallAgents({ dir: project, env: env(project) })).toBe(0);
    const agentsDir = path.join(project, ".opencode", "agents");
    const fm = frontmatter(path.join(agentsDir, "researcher.md"));

    expect(fm).not.toHaveProperty("temperature");
    expect(fm).not.toHaveProperty("permission");
    expect(fm.hidden).toBeUndefined();
    const rules = fm.permissions as Array<{ action: string; resource: string; effect: string }>;
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const action of ["edit", "shell", "execute", "subagent"]) {
      expect(rules).toContainEqual({ action, resource: "*", effect: "deny" });
    }
  });

  it("installs permission variants hidden, with matching rules", async () => {
    const project = tmp();
    await runInstallAgents({ dir: project, env: env(project) });
    const fm = frontmatter(path.join(project, ".opencode", "agents", "researcher__rw.md"));
    expect(fm.hidden).toBe(true);
    const rules = fm.permissions as Array<{ action: string; resource: string; effect: string }>;
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(rules).toContainEqual({ action: "shell", resource: "*", effect: "allow" });
  });

  it("does not overwrite foreign files without --force, but refreshes its own", async () => {
    const project = tmp();
    const agentsDir = path.join(project, ".opencode", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "reviewer.md"), "---\ndescription: mine\n---\nmine\n");

    expect(await runInstallAgents({ dir: project, env: env(project) })).toBe(1);
    expect(fs.readFileSync(path.join(agentsDir, "reviewer.md"), "utf8")).toContain("mine");

    fs.writeFileSync(path.join(agentsDir, "coder.md"), `---\n${GENERATED_MARKER}\n---\nold\n`);
    await runInstallAgents({ dir: project, env: env(project) });
    expect(fs.readFileSync(path.join(agentsDir, "coder.md"), "utf8")).not.toContain("old");

    expect(await runInstallAgents({ dir: project, force: true, env: env(project) })).toBe(0);
    expect(fs.readFileSync(path.join(agentsDir, "reviewer.md"), "utf8")).toContain(
      GENERATED_MARKER,
    );
  });

  it("--global targets the OpenCode config directory", async () => {
    const home = tmp();
    await runInstallAgents({ global: true, env: env(home) });
    expect(fs.existsSync(path.join(home, "cfg", "opencode", "agents", "tester.md"))).toBe(true);
  });
});
