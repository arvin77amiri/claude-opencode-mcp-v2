import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import {
  agentCapabilities,
  buildAgentDefinitions,
  expandAgentVariants,
  isVariantAgentName,
  loadBuiltinAgentDefinitions,
  loadProjectAgentDefinitions,
  normalizeModel,
  parseAgentMarkdown,
  resolveAgentVariant,
  toOpenCodeAgentConfig,
} from "../../src/opencode/agents.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-agents-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("parseAgentMarkdown", () => {
  it("parses YAML frontmatter and body", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "description: Test agent",
        "mode: all",
        "temperature: 0.2",
        "---",
        "",
        "You help.",
      ].join("\n"),
      "test.md",
    );
    expect(parsed.frontmatter.description).toBe("Test agent");
    expect(parsed.frontmatter.temperature).toBe(0.2);
    expect(parsed.body).toBe("You help.");
  });

  it("tolerates files without frontmatter", () => {
    const parsed = parseAgentMarkdown("Just a prompt.", "test.md");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Just a prompt.");
  });
});

describe("builtin agent definitions", () => {
  it("loads the four PRD agents with prompts", async () => {
    const definitions = await loadBuiltinAgentDefinitions();
    expect(definitions.map((entry) => entry.name).sort()).toEqual([
      "coder",
      "researcher",
      "reviewer",
      "tester",
    ]);
    for (const definition of definitions) {
      expect(definition.prompt.length).toBeGreaterThan(100);
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.mode).toBe("all");
    }
  });

  it("maps agent capabilities from profiles", async () => {
    const definitions = await loadBuiltinAgentDefinitions();
    const byName = new Map(definitions.map((entry) => [entry.name, entry]));
    expect(agentCapabilities(byName.get("researcher")!).readOnly).toBe(true);
    expect(agentCapabilities(byName.get("reviewer")!).canEdit).toBe(false);
    expect(agentCapabilities(byName.get("coder")!).canEdit).toBe(true);
    expect(agentCapabilities(byName.get("tester")!).canRunBash).toBe(true);
    expect(agentCapabilities(byName.get("tester")!).canEdit).toBe(false);
  });
});

describe("project and config overrides", () => {
  it("lets project files override builtin prompts", async () => {
    const dir = await tempDir();
    await fs.promises.mkdir(path.join(dir, ".claude-opencode", "agents"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, ".claude-opencode", "agents", "coder.md"),
      ["---", "description: Custom coder", "---", "CUSTOM PROMPT"].join("\n"),
    );

    const builtin = await loadBuiltinAgentDefinitions();
    const project = await loadProjectAgentDefinitions(dir);
    const definitions = buildAgentDefinitions({ builtin, project, config: DEFAULT_CONFIG });
    const coder = definitions.find((entry) => entry.name === "coder");
    expect(coder?.prompt).toBe("CUSTOM PROMPT");
    expect(coder?.description).toBe("Custom coder");
    expect(coder?.source).toBe("project");
  });

  it("applies config agents overrides and disables agents", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        researcher: { model: "deepseek/deepseek-v4-pro", temperature: 0.3 },
        tester: { enabled: false },
      },
    };
    const definitions = buildAgentDefinitions({
      builtin,
      project: [],
      config: config as typeof DEFAULT_CONFIG,
    });
    const researcher = definitions.find((entry) => entry.name === "researcher");
    expect(researcher?.model).toBe("deepseek/deepseek-v4-pro");
    expect(researcher?.temperature).toBe(0.3);
    expect(definitions.find((entry) => entry.name === "tester")).toBeUndefined();
  });

  it("builds OpenCode agent config with permissions and model", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const config = toOpenCodeAgentConfig(definitions, DEFAULT_CONFIG);
    expect(Object.keys(config)).toHaveLength(4);
    expect(config.coder?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(config.coder?.system).toBeTruthy();
    expect(config.researcher?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "deny",
    });
    expect(config.researcher?.permissions).toContainEqual({
      action: "bash",
      resource: "*",
      effect: "deny",
    });
    expect(config.coder?.mode).toBe("all");
  });

  it("only completes bare model ids when a provider is configured", () => {
    expect(normalizeModel("deepseek-v4-pro", DEFAULT_CONFIG)).toBeNull();
    const withProvider = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, provider: "deepseek" },
    };
    expect(normalizeModel("deepseek-v4-pro", withProvider)).toBe("deepseek/deepseek-v4-pro");
    expect(normalizeModel("deepseek/deepseek-v4-pro", DEFAULT_CONFIG)).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });
});

describe("permission overrides", () => {
  async function researcher() {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    return definitions.find((entry) => entry.name === "researcher")!;
  }

  it("keeps the base name when no override is given", async () => {
    const variant = resolveAgentVariant(await researcher());
    expect(variant.name).toBe("researcher");
    expect(variant.capabilities).toEqual({ readOnly: true, canEdit: false, canRunBash: false });
  });

  it("grants edits through the safe edit profile", async () => {
    const variant = resolveAgentVariant(await researcher(), { allowEdits: true });
    expect(variant.name).toBe("researcher__edit");
    expect(variant.profile).toBe("edit");
    expect(variant.capabilities).toEqual({ readOnly: false, canEdit: true, canRunBash: false });
  });

  it("grants edits and shell through the code profile", async () => {
    const variant = resolveAgentVariant(await researcher(), {
      allowEdits: true,
      allowBash: true,
    });
    expect(variant.name).toBe("researcher__rw");
    expect(variant.profile).toBe("code");
  });

  it("grants shell only through the test profile", async () => {
    const variant = resolveAgentVariant(await researcher(), { allowBash: true });
    expect(variant.name).toBe("researcher__bash");
    expect(variant.profile).toBe("test");
  });

  it("revokes shell from coder while keeping edits", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const coder = definitions.find((entry) => entry.name === "coder")!;
    const variant = resolveAgentVariant(coder, { allowBash: false });
    expect(variant.name).toBe("coder__edit");
    expect(variant.capabilities).toEqual({ readOnly: false, canEdit: true, canRunBash: false });
  });

  it("expands every agent into four capability variants with safe permissions", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const expanded = expandAgentVariants(definitions);
    expect(expanded).toHaveLength(definitions.length * 4);

    const names = expanded.map((entry) => entry.name);
    expect(names).toContain("researcher");
    expect(names).toContain("researcher__edit");
    expect(names).toContain("researcher__bash");
    expect(names).toContain("researcher__rw");

    const config = toOpenCodeAgentConfig(expanded, DEFAULT_CONFIG);
    const rw = config.researcher__rw!;
    expect(rw.permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(rw.permissions).toContainEqual({ action: "edit", resource: "*.env", effect: "deny" });
    const editor = config.researcher__edit!;
    expect(editor.permissions).toContainEqual({ action: "bash", resource: "*", effect: "deny" });
    expect(editor.permissions).toContainEqual({
      action: "edit",
      resource: "*.env",
      effect: "deny",
    });
  });

  it("rejects agent names that use the reserved variant separator", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    expect(() => expandAgentVariants([{ ...definitions[0]!, name: "bad__name" }])).toThrowError();
    expect(isVariantAgentName("coder__rw")).toBe(true);
  });
});
