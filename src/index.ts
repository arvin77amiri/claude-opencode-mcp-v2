#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { runInit } from "./cli/init.js";
import { runInstallAgents } from "./cli/install-agents.js";
import { loadConfig } from "./config/config.js";
import { createMcpServer, SERVER_VERSION } from "./mcp/server.js";
import { readDesktopService } from "./opencode/desktop-service.js";
import { OpenCodeManager } from "./opencode/manager.js";
import { SessionRegistry } from "./opencode/sessions.js";
import { prepareRun } from "./opencode/setup.js";
import { createLogger, defaultLogFile, stateDirectory } from "./util/logger.js";

async function runServer(): Promise<void> {
  const logger = createLogger({ file: defaultLogFile() });
  const env = process.env;
  const stateDir = stateDirectory();

  let globalConfig: Awaited<ReturnType<typeof loadConfig>>["config"];
  try {
    globalConfig = (await loadConfig({ env })).config;
  } catch (error) {
    logger.error("failed to load configuration", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const registry = new SessionRegistry(path.join(stateDir, "sessions.json"), logger);
  const manager = new OpenCodeManager({ logger, env });
  const server = createMcpServer({ logger, manager, registry, globalConfig, env, stateDir });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { reason });
    try {
      await server.close();
    } catch {
      // ignore
    }
    try {
      await manager.stopAll();
    } catch {
      // ignore
    }
    logger.info("shutdown complete");
    setImmediate(() => process.exit(0));
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("claude-opencode-mcp started", {
    pid: process.pid,
    cwd: process.cwd(),
    state_dir: stateDir,
  });

  server.server.onclose = () => {
    void shutdown("transport closed");
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Never orphan an OpenCode child, even if we exit through an unexpected path.
  process.on("exit", () => manager.killAllSync());

  const desktop = globalConfig.opencode.desktop;
  if (desktop) {
    // Desktop mode: only report whether the app is reachable. Connecting happens per run
    // (the app may be opened or restarted later) and never spawns an engine.
    try {
      const service = readDesktopService({ file: globalConfig.opencode.serviceFile, env });
      logger.info("OpenCode Desktop service found", {
        url: service.url,
        pid: service.pid,
        version: service.version,
      });
    } catch (error) {
      logger.warn("OpenCode Desktop service not available yet", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (globalConfig.opencode.autoStart && !globalConfig.opencode.url) {
    setImmediate(() => {
      void (async () => {
        try {
          await prepareRun({ manager, logger, env, globalConfig }, {});
          logger.info("warmed up OpenCode for the default workspace");
        } catch (error) {
          logger.debug("OpenCode warmup skipped", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("claude-opencode-mcp")
    .description(
      "MCP bridge that lets Claude Code delegate tasks to OpenCode agents (on the configured model or your OpenCode default) in the same workspace.",
    )
    .version(SERVER_VERSION, "-v, --version", "print the bridge version")
    .action(async () => {
      await runServer();
    });

  program
    .command("init")
    .description("initialize optional project-local configuration and validate the environment")
    .option("--dir <path>", "project directory (defaults to the current directory)")
    .option("--force", "overwrite existing generated files")
    .option("--write-mcp", "create or update .mcp.json in the project")
    .action(async (options: { dir?: string; force?: boolean; writeMcp?: boolean }) => {
      const code = await runInit({
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.writeMcp ? { writeMcp: true } : {}),
      });
      process.exitCode = code;
    });

  program
    .command("install-agents")
    .description(
      "write the bridge agents (and hidden permission variants) as OpenCode 2.x agent files, for servers the bridge does not spawn",
    )
    .option("--dir <path>", "project directory: installs into <dir>/.opencode/agents")
    .option("--global", "install into the global OpenCode config (~/.config/opencode/agents)")
    .option("--force", "overwrite agent files not generated by this command")
    .option("--dry-run", "print the files instead of writing them")
    .action(
      async (options: { dir?: string; global?: boolean; force?: boolean; dryRun?: boolean }) => {
        process.exitCode = await runInstallAgents({
          ...(options.dir ? { dir: options.dir } : {}),
          ...(options.global ? { global: true } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
        });
      },
    );

  program
    .command("serve")
    .description("run the MCP stdio server (default command)")
    .action(async () => {
      await runServer();
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  process.stderr.write(
    `claude-opencode-mcp fatal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
