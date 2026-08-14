/**
 * dsh-chatgpt-bridge plugin entry: a DSH (Cordis) plugin row that mounts the
 * MCP bridge. Removing or disabling the row (or the bundle) makes the MCP
 * endpoint disappear while DSH keeps running untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { ConfigSchema, resolveConfig, type BridgeConfigInput, type ResolvedBridgeConfig } from './config.js';
import { createBridgeLogger } from './log.js';
import { createMcpServer } from './mcp.js';
import { startHttpServer } from './http.js';

export const name = 'chatgpt-bridge';

/** Core services the bridge needs before it can start. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'agentDefaultModel'];

/** Plugin configuration schema (schemastery, DSH convention). */
export const Config = ConfigSchema;

export function apply(ctx: Context, config: BridgeConfigInput): void {
  const cfg: ResolvedBridgeConfig = resolveConfig(config, process.env as Record<string, string | undefined>);
  const log = createBridgeLogger({
    level: cfg.logLevel,
    dshHome: cfg.dshHome,
    stdioSafe: cfg.transport === 'stdio',
    cordis: {
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
      error: (message) => ctx.logger.error(message),
    },
  });

  const bridge = new Bridge(ctx, cfg, log);
  bridge.start();

  const mcpServer = createMcpServer(bridge, cfg, log);
  let httpHandle: { close(): Promise<void> } | undefined;
  let stdioTransport: StdioServerTransport | undefined;

  if (cfg.transport === 'stdio') {
    log.info('MCP stdio transport active — speak JSON-RPC on stdin/stdout');
    stdioTransport = new StdioServerTransport();
    void mcpServer.connect(stdioTransport).catch((error) => {
      log.error(`stdio transport failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    void startHttpServer(
      () => createMcpServer(bridge, cfg, log),
      { host: cfg.host, port: cfg.port, authMode: cfg.authMode, authToken: cfg.authToken },
      log,
    )
      .then((handle) => {
        httpHandle = handle;
      })
      .catch((error) => {
        log.error(`failed to start MCP HTTP server: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // Full teardown: disabling or unloading the plugin row must remove the MCP
  // endpoint while DSH keeps running untouched. Bridge-owned agents are
  // disposed with this fiber; their sessions stay persisted for later resume.
  (ctx as unknown as { on(event: string, cb: () => void): void }).on('dispose', () => {
    log.info('bridge shutting down: closing MCP server and transports');
    void (async () => {
      try {
        if (httpHandle !== undefined) await httpHandle.close();
      } catch (error) {
        log.error(`http server close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (stdioTransport !== undefined) await stdioTransport.close();
      } catch {
        // best-effort
      }
      try {
        await mcpServer.close();
      } catch {
        // best-effort
      }
    })();
  });
}