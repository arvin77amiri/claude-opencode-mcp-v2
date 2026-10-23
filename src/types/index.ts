import type { TaskWorktree } from "../workspace/worktree.js";

/** The resolved, validated workspace a delegated agent operates in. */
export interface AgentWorkspace {
  /** Canonical (realpath) absolute directory the agent works in. */
  cwd: string;
  /** The path the caller asked for, before canonicalization. */
  requestedPath: string;
  /** Optional soft hints supplied with the task. Never a hard restriction. */
  allowedPaths?: string[];
  /** Paths that are protected by policy (informational). */
  deniedPaths?: string[];
  /** Canonical git repository root, when the workspace is inside one. */
  gitRoot?: string;
  /** Whether the selected agent is restricted to read-only operation. */
  readOnly: boolean;
  /** OpenCode project identifier for the workspace. */
  projectID?: string;
}

export type SessionStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

/** A delegated task/agent session tracked by the bridge. */
export interface AgentSession {
  id: string;
  cwd: string;
  /** Base agent name shown to the orchestrator. */
  agent: string;
  /** Permission-variant agent used for prompts, when it differs from `agent`. */
  promptAgent?: string;
  /** Effective per-session capabilities (orchestrator overrides included). */
  canEdit?: boolean;
  canRunBash?: boolean;
  provider: string | null;
  model: string | null;
  title: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** OpenCode message id of the last assistant response, when known. */
  lastMessageID?: string;
  /** Bridge-level result summary of the last completed run. */
  lastSummary?: string;
  lastError?: { code: string; message: string };
  durationMs?: number;
  /** Cost and tokens added up over every run of the session. */
  usage?: RunUsage;
  /** Workspace the orchestrator asked for; differs from `cwd` when the session runs in a worktree. */
  originCwd?: string;
  /** Isolated worktree of an editing session (see merge_task / discard_task). */
  worktree?: SessionWorktree;
  /** Git state of the workspace when the session was created; basis of the get_diff fallback. */
  gitBaseline?: import("../util/git.js").GitBaseline;
}

export interface Finding {
  severity?: string;
  title: string;
  detail?: string;
  file?: string;
  line?: number;
}

export interface DelegateResult {
  status: "completed" | "failed" | "aborted" | "timeout";
  session_id: string;
  agent: string;
  cwd: string;
  model: string | null;
  summary: string;
  findings: Finding[];
  /** Total number of files changed in the session's workspace. */
  files_changed: number;
  /** The changed files (the first MAX_CHANGED_FILES of them). */
  changed_files: DiffFileSummary[];
  duration_ms: number;
  truncated: boolean;
  /** Cost and tokens of this run, when OpenCode reports them. */
  usage?: RunUsage;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Cost (USD, as reported by OpenCode) and token counts of one or more runs. */
export interface RunUsage {
  cost: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface AgentInfo {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  readOnly: boolean;
  canEdit: boolean;
  canRunBash: boolean;
  model: string | null;
  source: "builtin" | "project" | "opencode";
}

export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;
export type PermissionConfig = Record<string, PermissionRule>;

export interface AgentDefinition {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  prompt: string;
  permission: PermissionConfig;
  model: string | null;
  temperature?: number;
  /** Permission profile override (only honoured for project/configured agents). */
  profile?: import("../security/policy.js").AgentProfile;
  source: "builtin" | "project";
}

export interface RunProgress {
  progress: number;
  total?: number;
  message: string;
}

export interface RunResult {
  status: "completed" | "failed" | "timeout";
  summary: string;
  findings: Finding[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  durationMs: number;
  messageID?: string;
  truncated: boolean;
  usage?: RunUsage;
}

export interface DiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted" | "renamed" | "unknown";
}

export interface DiffResult {
  session_id: string;
  cwd: string;
  source: "opencode";
  files: DiffFileSummary[];
  diff: string;
  truncated: boolean;
  note?: string;
}

/** A session's task worktree plus its lifecycle state. */
export interface SessionWorktree extends TaskWorktree {
  state: "active" | "merged" | "discarded";
  /** Commit created on the base branch by merge_task. */
  mergedCommit?: string;
  /**
   * Set when the worktree directory or branch could not be deleted yet (e.g. the
   * OpenCode service still held the directory on Windows). Retried later.
   */
  cleanupPending?: string;
}
