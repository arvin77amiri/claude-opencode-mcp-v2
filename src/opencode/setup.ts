import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import { type ProfileCapabilities, toPermissionRuleset } from "../security/policy.js";
import type { AgentDefinition, AgentWorkspace } from "../types/index.js";
import type { Logger } from "../util/logger.js";
import { type ResolveWorkspaceInput, resolveWorkspace } from "../workspace/resolver.js";
import {
  agentCapabilities,
  agentPermissions,
  buildAgentDefinitions,
  expandAgentVariants,
  findAgentDefinition,
  isVariantAgentName,
  loadBuiltinAgentDefinitions,
  loadProjectAgentDefinitions,
  resolveAgentVariant,
  resolveSessionAgent,
  type SessionAgentBinding,
  toOpenCodeAgentConfig,
  VARIANT_SEPARATOR,
} from "./agents.js";
import type { ModelRef, PermissionRuleset } from "./api-types.js";
import type { OpenCodeClient } from "./client.js";
import type { OpenCodeManager } from "./manager.js";
import { formatModelRef, resolveModel } from "./run.js";

export interface PrepareRunInput {
  cwd?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  /** Orchestrator override: grant/revoke file edits for this run. */
  allowEdits?: boolean | undefined;
  /** Orchestrator override: grant/revoke shell commands for this run. */
  allowBash?: boolean | undefined;
}

export interface PreparedRun {
  workspace: AgentWorkspace;
  config: ResolvedConfig;
  definitions: AgentDefinition[];
  /** Agent definition actually used for the prompt (may be a variant). */
  definition: AgentDefinition;
  /** Base agent name shown to the orchestrator. */
  baseAgentName: string;
  capabilities: ProfileCapabilities;
  client: OpenCodeClient;
  serverKey: string;
  /** How the agent is realised on the OpenCode session (agent id and/or prompt preamble). */
  agentBinding: SessionAgentBinding;
  /** Permission ruleset sent with the session (derived from the security policy). */
  permissions: PermissionRuleset;
  model: ModelRef | null;
  modelString: string | null;
}

export interface PrepareDeps {
  manager: OpenCodeManager;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  globalConfig: ResolvedConfig;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

let builtinCache: AgentDefinition[] | null = null;

/**
 * Compare the directory OpenCode reports for a new session with the workspace
 * the bridge asked for. Last line of defence against a misrouted session.
 */
export function assertSessionLocation(
  reported: string | undefined,
  workspace: AgentWorkspace,
): void {
  if (!reported) return;
  const norm = (value: string) => {
    const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  if (norm(reported) !== norm(workspace.cwd)) {
    throw new BridgeError(
      "WORKSPACE_MISMATCH",
      `OpenCode created the session in ${reported} but the workspace is ${workspace.cwd}.`,
      { details: { requested: workspace.cwd, served: reported } },
    );
  }
}

/** Fail early when the model is not in the server catalog (POST /api/session does not validate). */
async function assertModelAvailable(
  client: OpenCodeClient,
  model: ModelRef | null,
  logger: Logger,
): Promise<void> {
  if (!model) return;
  let catalog: Awaited<ReturnType<OpenCodeClient["models"]>>;
  try {
    catalog = await client.models();
  } catch (error) {
    logger.debug("could not list models; skipping model validation", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (catalog.length === 0) return;
  if (!catalog.some((entry) => entry.providerID === model.providerID && entry.id === model.id)) {
    throw new BridgeError(
      "MODEL_NOT_AVAILABLE",
      `Model ${model.providerID}/${model.id} is not available in OpenCode.`,
      { details: { requested: formatModelRef(model), available: catalog.length } },
    );
  }
}

export async function getBuiltinDefinitions(): Promise<AgentDefinition[]> {
  if (!builtinCache) builtinCache = await loadBuiltinAgentDefinitions();
  return builtinCache;
}

export function clearBuiltinCache(): void {
  builtinCache = null;
}

export async function prepareRun(
  deps: PrepareDeps,
  input: PrepareRunInput,
  workspaceOverride?: AgentWorkspace,
): Promise<PreparedRun> {
  const resolution = workspaceOverride
    ? null
    : await resolveWorkspace({
        cwd: input.cwd,
        env: deps.env,
        globalConfig: deps.globalConfig,
        ...(deps.loadProjectConfig ? { loadProjectConfig: deps.loadProjectConfig } : {}),
      } as ResolveWorkspaceInput);

  const workspace = workspaceOverride ?? resolution!.workspace;
  const config = resolution?.config ?? deps.globalConfig;

  const [builtin, project] = await Promise.all([
    getBuiltinDefinitions(),
    loadProjectAgentDefinitions(workspace.cwd),
  ]);
  const definitions = buildAgentDefinitions({ builtin, project, config });

  const agentName = normalizeLegacyAgentName((input.agent ?? config.defaults.agent).trim());
  const definition = findAgentDefinition(definitions, agentName);
  if (!definition) {
    throw new BridgeError("AGENT_NOT_FOUND", `Unknown agent: ${agentName}`, {
      details: {
        requested: agentName,
        available: definitions
          .filter((entry) => !isVariantAgentName(entry.name))
          .map((entry) => entry.name),
      },
    });
  }

  // The orchestrator can grant or revoke edits/shell per call; the override is
  // expressed as a generated variant agent with a safe permission profile.
  const variant = resolveAgentVariant(definition, {
    ...(input.allowEdits !== undefined ? { allowEdits: input.allowEdits } : {}),
    ...(input.allowBash !== undefined ? { allowBash: input.allowBash } : {}),
  });
  const allDefinitions = expandAgentVariants(definitions);
  const promptDefinition = allDefinitions.find((entry) => entry.name === variant.name);
  if (!promptDefinition) {
    throw new BridgeError("AGENT_NOT_FOUND", `Agent variant is unavailable: ${variant.name}`, {
      details: { base: definition.name, variant: variant.name },
    });
  }

  const agentConfig = toOpenCodeAgentConfig(allDefinitions, config);
  const serverInput = {
    cwd: workspace.cwd,
    config,
    agentConfig,
  };
  const serverKey = await deps.manager.ensure(serverInput);

  const client = await deps.manager.clientFor(serverInput);
  const resolved = await resolveModel(client, config, input.model ?? definition.model);
  await assertModelAvailable(client, resolved, deps.logger);
  const agentBinding = await resolveSessionAgent(async () => {
    const found: Array<{ id: string; name: string }> = [];
    for (const name of new Set([
      promptDefinition.name,
      promptDefinition.name.split(VARIANT_SEPARATOR)[0] ?? promptDefinition.name,
    ])) {
      const info = await lookupAgentWithWarmup(client, name);
      if (info) found.push({ id: info.id, name: info.name });
    }
    return found;
  }, promptDefinition);

  return {
    workspace: { ...workspace, readOnly: variant.capabilities.readOnly },
    config,
    definitions,
    definition: promptDefinition,
    baseAgentName: definition.name,
    capabilities: variant.capabilities,
    client,
    serverKey,
    agentBinding,
    permissions: toPermissionRuleset(agentPermissions(promptDefinition, config)),
    model: resolved,
    modelString: formatModelRef(resolved),
  };
}

/**
 * Compute the override the orchestrator effectively applied to a prepared run,
 * for display in the task context. Returns undefined when the capabilities
 * match the base agent's defaults.
 */
export function effectivePermissionOverride(
  prepared: PreparedRun,
): { allowEdits?: boolean; allowBash?: boolean } | undefined {
  const base = prepared.definitions.find((entry) => entry.name === prepared.baseAgentName);
  const baseCapabilities = base ? agentCapabilities(base) : null;
  if (
    baseCapabilities &&
    baseCapabilities.canEdit === prepared.capabilities.canEdit &&
    baseCapabilities.canRunBash === prepared.capabilities.canRunBash
  ) {
    return undefined;
  }
  return {
    allowEdits: prepared.capabilities.canEdit,
    allowBash: prepared.capabilities.canRunBash,
  };
}

/**
 * OpenCode 2 answers 404 for agents defined through OPENCODE_CONFIG_CONTENT
 * for about a second after "listening" (config warm-up), so one 404 does not
 * mean "unknown". Retry briefly before giving up.
 */
async function lookupAgentWithWarmup(
  client: OpenCodeClient,
  name: string,
  timeoutMs = 6_000,
): ReturnType<OpenCodeClient["agent"]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await client.agent(name);
    if (info || Date.now() >= deadline) return info;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** v1/early-v2 names carried a `deepseek-` prefix (`deepseek-coder` -> `coder`). */
function normalizeLegacyAgentName(name: string): string {
  const match = /^deepseek-(researcher|reviewer|coder|tester)(__.*)?$/.exec(name);
  return match ? `${match[1]}${match[2] ?? ""}` : name;
}
