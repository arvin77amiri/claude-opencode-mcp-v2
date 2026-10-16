/**
 * Hand-written types for the subset of the OpenCode v2 HTTP API (`/api/*`)
 * used by the bridge. Source of truth: research/opencode-v2-openapi.json
 * (OpenCode 2.0.22, "Experimental HttpApi surface" v0.0.1).
 *
 * Only fields the bridge reads are typed; everything else is left open.
 */

export interface Envelope<T> {
  data: T;
  location?: LocationRef;
}

export interface LocationRef {
  directory: string;
  [key: string]: unknown;
}

export interface ServerInfo {
  version: string;
  pid?: number;
  urls?: string[];
  paths?: Record<string, string>;
}

/** Model reference used when creating a session (v2 shape, not v1's {providerID, modelID}). */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export type PermissionRuleset = PermissionRule[];

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

export type SessionOutcome = "succeeded" | "failed" | "interrupted";

export interface SessionInfo {
  id: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  cost?: number;
  outcome?: SessionOutcome;
  location?: LocationRef;
  time?: { created: number; updated: number; idle?: number };
}

export interface CreateSessionBody {
  title?: string | null;
  agent?: string | null;
  model?: ModelRef | null;
  location?: { directory: string } | null;
  metadata?: Record<string, unknown> | null;
  permissions?: PermissionRuleset | null;
}

export interface PatchSessionBody {
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  permissions?: PermissionRuleset | null;
}

export type ActiveSessions = Record<string, { type: string; [key: string]: unknown }>;

export interface PromptBody {
  text: string;
  delivery?: "steer" | "queue" | null;
  metadata?: Record<string, unknown>;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolContent {
  type: "tool";
  id?: string;
  name: string;
  state?: { status?: string; input?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OtherContent {
  type: string;
  [key: string]: unknown;
}

export type AssistantContent = TextContent | ToolContent | OtherContent;

export interface UserMessage {
  id: string;
  type: "user";
  text?: string;
  time: { created: number };
}

export interface AssistantMessage {
  id: string;
  type: "assistant";
  agent?: string;
  model?: ModelRef;
  content?: AssistantContent[];
  finish?: string;
  error?: unknown;
  cost?: number;
  time: { created: number; streamed?: number; completed?: number };
}

export interface IdleMessage {
  id: string;
  type: "idle";
  outcome: SessionOutcome;
  error?: unknown;
  time: { created: number };
}

export interface OtherMessage {
  id: string;
  type: string;
  time?: { created: number };
  [key: string]: unknown;
}

export type SessionMessage = UserMessage | AssistantMessage | IdleMessage | OtherMessage;

export interface MessagePage {
  data: SessionMessage[];
  cursor?: { previous?: string; next?: string };
}

export interface FileDiff {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden?: boolean;
  permissions?: PermissionRuleset;
}

export interface ModelInfo {
  id: string;
  modelID?: string;
  providerID: string;
  variants?: string[];
}

/** One server-sent event from `GET /api/event`. */
export interface ServerEvent {
  id?: string;
  created?: number;
  type: string;
  location?: LocationRef;
  data: Record<string, unknown>;
}
