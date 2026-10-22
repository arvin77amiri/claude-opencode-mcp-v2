import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { deepMerge, type ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import type { Logger } from "../util/logger.js";
import { BinaryResolver, needsShell, type ResolveBinaryOptions, shellQuote } from "./binary.js";
import { type AuthCredentials, fetchHealth, normalizeBaseUrl, OpenCodeClient } from "./client.js";
import { readDesktopService, serviceFingerprint } from "./desktop-service.js";
import { PermissionWatcher } from "./permission-watcher.js";

export interface ServerStatus {
  key: string;
  url: string;
  external: boolean;
  version: string | null;
  activeRuns: number;
  lastUsedAt: number;
}

interface ServerRecord {
  key: string;
  baseUrl: string;
  external: boolean;
  process: ChildProcess | null;
  version: string | null;
  auth: AuthCredentials | null;
  lastUsedAt: number;
  activeRuns: number;
  client: OpenCodeClient;
  watcher: PermissionWatcher;
  dead: boolean;
  stderr: string[];
  /** Set for an OpenCode Desktop service connection: identifies the app instance. */
  desktopFingerprint: string | null;
}

export interface EnsureServerInput {
  /** Directory used as the cwd of a spawned server (any workspace works afterwards). */
  cwd: string;
  config: ResolvedConfig;
  /**
   * Agent definitions handed to a spawned server through OPENCODE_CONFIG_CONTENT.
   * OpenCode 2.x reads them from the `agents` key (verified in research/FINDINGS.md).
   */
  agentConfig: Record<string, unknown>;
}

export interface OpenCodeManagerOptions {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  binaryOptions?: ResolveBinaryOptions;
}

interface SpawnOutcome {
  url: string;
  process: ChildProcess;
}

const LOCAL_KEY = "local";

/**
 * Kill a spawned server. On Windows the child is often a `cmd.exe` running the
 * `opencode.cmd` shim, and killing it alone leaves the real server orphaned
 * (still holding the port and the workspace directory), so kill the whole tree.
 */
function killProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status === 0) return;
  }
  child.kill(signal);
}

function mergeInlineConfig(
  existing: string | undefined,
  agentConfig: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed inherited config content
    }
  }
  return JSON.stringify(deepMerge(base, { agents: agentConfig }));
}

/**
 * Owns the connection to OpenCode. A single OpenCode 2.x server serves every
 * workspace (each session carries its own `location.directory`), so there is at
 * most one record: either an externally managed server (`opencode.url`) or one
 * child process spawned with `opencode serve`.
 */
export class OpenCodeManager {
  private record: ServerRecord | null = null;
  /** Every spawned child, tracked from creation so shutdown can always kill it. */
  private readonly children = new Set<ChildProcess>();
  /** In-flight startup deduplication: concurrent ensures share one startup. */
  private inflight: Promise<string> | null = null;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolver: BinaryResolver;
  private stopping = false;

  constructor(options: OpenCodeManagerOptions) {
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.resolver = new BinaryResolver(options.binaryOptions ?? {});
  }

  resolveAuth(config: ResolvedConfig): AuthCredentials | null {
    const password = config.opencode.password ?? this.env.OPENCODE_SERVER_PASSWORD ?? null;
    if (!password) return null;
    const username = config.opencode.username ?? this.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return { username, password };
  }

  /** Ensure the OpenCode server is available and return its record key. */
  async ensure(input: EnsureServerInput): Promise<string> {
    if (this.stopping) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }
    const desktop = input.config.opencode.desktop;
    const current = this.record;
    if (current && !current.dead) {
      if (!desktop || this.desktopStillCurrent(current, input.config)) {
        current.lastUsedAt = Date.now();
        return current.key;
      }
    }
    if (this.inflight) return this.inflight;

    const task = (
      desktop
        ? this.ensureDesktop(input)
        : input.config.opencode.url
          ? this.ensureExternal(input)
          : this.ensureLocal(input)
    ).finally(() => {
      this.inflight = null;
    });
    this.inflight = task;
    return task;
  }

  async clientFor(input: EnsureServerInput): Promise<OpenCodeClient> {
    await this.ensure(input);
    const record = this.record;
    if (!record || record.dead) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode server disappeared unexpectedly.");
    }
    record.lastUsedAt = Date.now();
    return record.client;
  }

  /**
   * Return the client only when a live server is already connected. Used by
   * read-only tools (get_session, get_diff, abort_session) that must not start
   * an OpenCode process as a side effect.
   */
  existingClient(): OpenCodeClient | null {
    const record = this.record;
    if (!record || record.dead) return null;
    record.lastUsedAt = Date.now();
    return record.client;
  }

  getExistingServerVersion(): string | null {
    const record = this.record;
    return record && !record.dead ? record.version : null;
  }

  /**
   * Desktop mode: re-read service.json and keep the connection only while it still points
   * at the same app instance. A restarted app (new port/password/pid) drops the record so
   * the next ensure reconnects; a closed app drops it and surfaces the clear error.
   */
  private desktopStillCurrent(record: ServerRecord, config: ResolvedConfig): boolean {
    try {
      const service = readDesktopService({ file: config.opencode.serviceFile, env: this.env });
      if (record.desktopFingerprint === serviceFingerprint(service)) return true;
      this.logger.info("OpenCode Desktop service changed; reconnecting", { url: service.url });
    } catch (error) {
      this.dropRecord(record);
      throw error;
    }
    this.dropRecord(record);
    return false;
  }

  private dropRecord(record: ServerRecord): void {
    if (this.record === record) this.record = null;
    record.dead = true;
    void record.watcher.stop().catch(() => undefined);
  }

  private async ensureDesktop(input: EnsureServerInput): Promise<string> {
    if (input.config.opencode.url) {
      this.logger.warn("opencode.desktop is set; ignoring opencode.url", {});
    }
    const service = readDesktopService({ file: input.config.opencode.serviceFile, env: this.env });
    return this.connectExternal(service.url, service.auth, {
      fingerprint: serviceFingerprint(service),
      unreachable: `OpenCode Desktop service at ${normalizeBaseUrl(service.url)} (pid ${service.pid}) did not answer GET /api/info. Restart OpenCode Desktop and retry.`,
    });
  }

  private async ensureExternal(input: EnsureServerInput): Promise<string> {
    const rawUrl = input.config.opencode.url;
    if (!rawUrl) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "opencode.url is not configured.");
    }
    const parsed = new URL(rawUrl);
    let auth = this.resolveAuth(input.config);
    if (parsed.username || parsed.password) {
      auth = {
        username: decodeURIComponent(parsed.username || "opencode"),
        password: decodeURIComponent(parsed.password),
      };
      parsed.username = "";
      parsed.password = "";
    }
    return this.connectExternal(parsed.toString(), auth, null);
  }

  private async connectExternal(
    rawUrl: string,
    auth: AuthCredentials | null,
    desktop: { fingerprint: string; unreachable: string } | null,
  ): Promise<string> {
    const baseUrl = normalizeBaseUrl(rawUrl);

    const health = await fetchHealth(baseUrl, auth);
    if (!health) {
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        desktop?.unreachable ??
          `Could not reach an OpenCode 2.x server at ${baseUrl} (GET /api/info failed; check the URL and credentials).`,
        { details: { url: baseUrl } },
      );
    }

    const client = new OpenCodeClient({ baseUrl, auth });
    this.record = {
      key: LOCAL_KEY,
      baseUrl,
      external: true,
      process: null,
      version: health.version,
      auth,
      lastUsedAt: Date.now(),
      activeRuns: 0,
      client,
      watcher: new PermissionWatcher(client, this.logger),
      dead: false,
      stderr: [],
      desktopFingerprint: desktop?.fingerprint ?? null,
    };
    this.logger.info(
      desktop ? "connected to OpenCode Desktop service" : "connected to external OpenCode server",
      { url: baseUrl, version: health.version },
    );
    return LOCAL_KEY;
  }

  private async ensureLocal(input: EnsureServerInput): Promise<string> {
    const stale = this.record;
    if (stale?.dead) {
      this.record = null;
      await stale.watcher.stop();
    }

    const binary = await this.resolver.resolve(input.config.opencode.binary);
    // OpenCode 2 always protects `serve`: without OPENCODE_SERVER_PASSWORD it
    // generates a random password and answers 401 to everyone else.
    const auth: AuthCredentials = this.resolveAuth(input.config) ?? {
      username: "opencode",
      password: randomBytes(24).toString("base64url"),
    };
    const stderr: string[] = [];
    const { url, process: child } = await this.spawnServer(input, binary.command, auth, stderr);

    if (this.stopping) {
      killProcess(child, "SIGKILL");
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }

    const health = await this.waitForHealth(url, auth);
    if (!health) {
      killProcess(child, "SIGKILL");
      if (this.stopping) {
        throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
      }
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        `OpenCode server started at ${url} but never became healthy.`,
        { details: { url, stderr: stderr.join("").slice(-2000) } },
      );
    }

    if (this.stopping) {
      killProcess(child, "SIGKILL");
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }

    const client = new OpenCodeClient({ baseUrl: url, auth });
    const record: ServerRecord = {
      key: LOCAL_KEY,
      baseUrl: url,
      external: false,
      process: child,
      version: health.version,
      auth,
      lastUsedAt: Date.now(),
      activeRuns: 0,
      client,
      watcher: new PermissionWatcher(client, this.logger),
      dead: false,
      stderr,
      desktopFingerprint: null,
    };
    this.record = record;

    child.on("exit", (code, signal) => {
      record.dead = true;
      void record.watcher.stop();
      if (!this.stopping) {
        this.logger.error("OpenCode server exited", {
          code,
          signal,
          activeRuns: record.activeRuns,
          stderr: stderr.join("").slice(-1000),
        });
      }
    });
    child.unref?.();

    this.logger.info("started OpenCode server", {
      cwd: input.cwd,
      url,
      version: health.version,
      binary: binary.command,
      source: binary.source,
    });
    return LOCAL_KEY;
  }

  private spawnServer(
    input: EnsureServerInput,
    command: string,
    auth: AuthCredentials | null,
    stderr: string[],
  ): Promise<SpawnOutcome> {
    const { config } = input;
    const args = [
      "serve",
      `--hostname=${config.opencode.hostname}`,
      `--port=${config.opencode.port}`,
    ];
    if (config.opencode.logLevel) args.push(`--log-level=${config.opencode.logLevel}`);

    const childEnv: NodeJS.ProcessEnv = { ...this.env };
    delete childEnv.OPENCODE_CLIENT;
    childEnv.OPENCODE_CONFIG_CONTENT = mergeInlineConfig(
      this.env.OPENCODE_CONFIG_CONTENT,
      input.agentConfig,
    );
    if (auth) {
      childEnv.OPENCODE_SERVER_USERNAME = auth.username;
      childEnv.OPENCODE_SERVER_PASSWORD = auth.password;
    }

    const child = spawn(shellQuote(command), args, {
      shell: needsShell(command),
      cwd: input.cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Track the child from the instant it exists: shutdown may race with
    // startup, and anything spawned must be killable even before ensureLocal
    // registers a server record.
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));

    return new Promise<SpawnOutcome>((resolve, reject) => {
      let settled = false;
      let output = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcess(child, "SIGKILL");
        reject(
          new BridgeError(
            "OPENCODE_START_TIMEOUT",
            `OpenCode did not start within ${config.opencode.startupTimeout}ms.`,
            { details: { stderr: stderr.join("").slice(-2000) }, retryable: true },
          ),
        );
      }, config.opencode.startupTimeout);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      // Ensure a rejected startup never leaves a process behind.
      const fail = (error: BridgeError) => {
        finish(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killProcess(child, "SIGKILL");
          }
          reject(error);
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (this.stopping) {
          fail(new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down."));
          return;
        }
        output += chunk.toString("utf8");
        for (const line of output.split("\n")) {
          if (!/listening on/i.test(line)) continue;
          const match = line.match(/(https?:\/\/[^\s]+)/);
          if (match?.[1]) {
            const url = normalizeBaseUrl(match[1]);
            finish(() => resolve({ url, process: child }));
            return;
          }
          fail(new BridgeError("OPENCODE_ERROR", `Could not parse server URL from: ${line}`));
          return;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
        if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
      });

      child.on("error", (error) => {
        fail(
          new BridgeError("OPENCODE_NOT_AVAILABLE", `Failed to launch OpenCode: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.on("exit", (code) => {
        finish(() =>
          reject(
            new BridgeError(
              "OPENCODE_UNAVAILABLE",
              `OpenCode exited during startup with code ${code}.`,
              { details: { stderr: stderr.join("").slice(-2000) } },
            ),
          ),
        );
      });
    });
  }

  private async waitForHealth(
    baseUrl: string,
    auth: AuthCredentials | null,
  ): Promise<{ healthy: boolean; version: string } | null> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (this.stopping) return null;
      const health = await fetchHealth(baseUrl, auth);
      if (health) return health;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  beginRun(_key: string, sessionId?: string): void {
    const record = this.record;
    if (!record) return;
    record.activeRuns += 1;
    record.lastUsedAt = Date.now();
    if (sessionId) record.watcher.activate(sessionId);
  }

  endRun(_key: string, sessionId?: string): void {
    const record = this.record;
    if (!record) return;
    record.activeRuns = Math.max(0, record.activeRuns - 1);
    if (sessionId) record.watcher.deactivate(sessionId);
  }

  isDead(_key?: string): boolean {
    return !this.record || this.record.dead;
  }

  getStatus(): ServerStatus[] {
    const record = this.record;
    if (!record) return [];
    return [
      {
        key: record.key,
        url: record.baseUrl,
        external: record.external,
        version: record.version,
        activeRuns: record.activeRuns,
        lastUsedAt: record.lastUsedAt,
      },
    ];
  }

  getRunningServerKeys(): string[] {
    return this.record && !this.record.dead ? [this.record.key] : [];
  }

  async stop(_key: string = LOCAL_KEY): Promise<void> {
    const record = this.record;
    if (!record) return;
    this.record = null;
    await record.watcher.stop();
    const child = record.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finalize = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finalize);
      try {
        killProcess(child, "SIGTERM");
      } catch {
        finalize();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          killProcess(child, "SIGKILL");
        } catch {
          // already gone
        }
        finalize();
      }, 5000);
      killTimer.unref?.();
    });
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await this.stop();
  }

  /**
   * Synchronous last-resort cleanup for `process.on("exit")`: kills any child
   * that was spawned but not yet registered (shutdown races) so no OpenCode
   * process is orphaned when the bridge exits.
   */
  killAllSync(): void {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          killProcess(child, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    this.children.clear();
  }
}
