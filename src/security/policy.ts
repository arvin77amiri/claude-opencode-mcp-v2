import type { SecurityConfig } from "../config/config.js";
import type { PermissionRuleset } from "../opencode/api-types.js";
import type { PermissionAction, PermissionConfig, PermissionRule } from "../types/index.js";
import { DEFAULT_SENSITIVE_PATTERNS, SENSITIVE_ALLOWLIST } from "./paths.js";

export type AgentProfile = "read" | "review" | "edit" | "code" | "test";

export interface ProfileCapabilities {
  readOnly: boolean;
  canEdit: boolean;
  canRunBash: boolean;
}

export const PROFILE_CAPABILITIES: Record<AgentProfile, ProfileCapabilities> = {
  read: { readOnly: true, canEdit: false, canRunBash: false },
  review: { readOnly: true, canEdit: false, canRunBash: false },
  edit: { readOnly: false, canEdit: true, canRunBash: false },
  code: { readOnly: false, canEdit: true, canRunBash: true },
  test: { readOnly: true, canEdit: false, canRunBash: true },
};

/** Pick the profile that matches an edit/shell capability combination. */
export function profileForCapabilities(canEdit: boolean, canRunBash: boolean): AgentProfile {
  if (canEdit && canRunBash) return "code";
  if (canEdit) return "edit";
  if (canRunBash) return "test";
  return "read";
}

function sensitiveFileRules(security: SecurityConfig): PermissionRule {
  if (!security.protectEnvFiles) return "allow";
  const rules: Record<string, PermissionAction> = { "*": "allow" };
  for (const pattern of DEFAULT_SENSITIVE_PATTERNS) rules[pattern] = "deny";
  for (const pattern of SENSITIVE_ALLOWLIST) rules[pattern] = "allow";
  for (const pattern of security.extraProtectedPatterns ?? []) rules[pattern] = "deny";
  return rules;
}

/**
 * Shell rules. OpenCode 2 matches them per simple command (`git add -A && git commit -m x`
 * is checked as `git add -A` and `git commit -m x`), but the patterns stay deliberately loose
 * (`*git*commit*`): a prefix pattern such as `git commit*` is bypassed by `git -C . commit`.
 * Sensitive files are blocked the same way, because `cat .env` would otherwise
 * undo the `read` protection.
 */
function shellRules(security: SecurityConfig): Record<string, PermissionAction> {
  const rules: Record<string, PermissionAction> = { "*": "allow" };
  if (security.denyGitPush) rules["*git*push*"] = "deny";
  if (security.denyGitCommit) rules["*git*commit*"] = "deny";
  if (security.protectEnvFiles) {
    for (const pattern of DEFAULT_SENSITIVE_PATTERNS) rules[`*${pattern}*`] = "deny";
    for (const pattern of security.extraProtectedPatterns ?? []) rules[`*${pattern}*`] = "deny";
    for (const pattern of SENSITIVE_ALLOWLIST) rules[`*${pattern}*`] = "allow";
  }
  return rules;
}

/**
 * Build the OpenCode permission config for an agent profile.
 *
 * `ask` is deliberately never emitted: the bridge is headless and an `ask`
 * rule would leave a delegated agent waiting for a human forever.
 */
export function buildPermissions(
  profile: AgentProfile,
  security: SecurityConfig,
): PermissionConfig {
  const capabilities = PROFILE_CAPABILITIES[profile];
  const externalDirectory: PermissionAction = security.externalDirectory ?? "deny";
  const base: PermissionConfig = {
    read: sensitiveFileRules(security),
    glob: "allow",
    // `grep` is authorised by its search pattern, not by the files it reads, so it cannot
    // honour the per-file `read` rules above and would print `.env` contents.
    grep: security.protectEnvFiles ? "deny" : "allow",
    list: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow",
    skill: "allow",
    // OpenCode 2.x names these `subagent` and `shell` (v1: `task` / `bash`); a rule under the
    // old name is silently ignored.
    subagent: "deny",
    question: "deny",
    doom_loop: "deny",
    external_directory: externalDirectory,
  };

  if (capabilities.canEdit) {
    base.edit = sensitiveFileRules(security);
  } else {
    base.edit = "deny";
  }

  if (capabilities.canRunBash) {
    base.shell = shellRules(security);
  } else {
    base.shell = "deny";
  }

  return base;
}

export function profileForAgent(name: string): AgentProfile | null {
  switch (name) {
    case "researcher":
      return "read";
    case "reviewer":
      return "review";
    case "coder":
      return "code";
    case "tester":
      return "test";
    default:
      return null;
  }
}

/**
 * Convert the v1-style permission config (`{ tool: action | { pattern: action } }`)
 * into the OpenCode v2 ruleset (`[{ action, resource, effect }]`) accepted by
 * `POST /api/session` and `PATCH /api/session/{id}`.
 *
 * Rule order is preserved (broad `*` first, specific patterns after), which
 * matches the "last matching rule wins" evaluation of the original config.
 */
export function toPermissionRuleset(config: PermissionConfig): PermissionRuleset {
  const rules: PermissionRuleset = [];
  for (const [action, rule] of Object.entries(config)) {
    if (typeof rule === "string") {
      rules.push({ action, resource: "*", effect: rule });
      continue;
    }
    for (const [resource, effect] of Object.entries(rule)) {
      rules.push({ action, resource, effect });
    }
  }
  return rules;
}
