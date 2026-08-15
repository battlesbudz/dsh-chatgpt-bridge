import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, Config } from '../../lib/index.js';
import { createMcpServer } from '../../lib/mcp.js';
import { startHttpServer } from '../../lib/http.js';

const EXPECTED_TOOLS = [
  'dsh_health',
  'dsh_list_workspaces',
  'dsh_create_session',
  'dsh_list_sessions',
  'dsh_get_session',
  'dsh_send_message',
  'dsh_get_task_status',
  'dsh_get_result',
  'dsh_cancel_task',
  'dsh_answer_question',
  'dsh_approve',
  'dsh_start_goal',
  'dsh_wait_goal',
  'dsh_stop_goal',
  'dsh_update_goal',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitListening(port, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      return response.status;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw last ?? new Error(`port ${port} never accepted connections`);
}

async function waitClosed(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 40));
    } catch {
      return;
    }
  }
  throw new Error(`port ${port} still accepted connections after close`);
}

function pluginCtx() {
  const disposers = [];
  const services = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  return {
    disposers,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: (key) => services[key],
      agents: services.agents,
      sessions: services.sessions,
      sessionPersistence: services.sessionPersistence,
      agentDefaultModel: services.agentDefaultModel,
      on: () => () => true,
      inject: () => ({}),
      effect: (execute) => {
        const disposer = execute();
        disposers.push(disposer);
        return disposer;
      },
    },
  };
}

test('shipped plugin entry exports name, apply, and Config', async () => {
  assert.equal(name, 'chatgpt-bridge');
  assert.equal(typeof apply, 'function');
  assert.ok(Config);
});

test('createMcpServer registers exactly the 15 public dsh_* tools', () => {
  const server = createMcpServer(
    {},
    { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const names = Object.keys(server._registeredTools).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  assert.equal(names.length, 15);
});

test('package clean script is ESM-safe under type:module', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.match(manifest.scripts.clean, /import\s*\{[^}]*rmSync/);
  assert.doesNotMatch(manifest.scripts.clean, /\brequire\s*\(/);
});

test('startHttpServer.close stops accepting connections', async () => {
  const port = await freePort();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const handle = await startHttpServer(
    () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
    { host: '127.0.0.1', port, authMode: 'none', authToken: '' },
    log,
  );
  try {
    const status = await waitListening(handle.port);
    assert.equal(typeof status, 'number');
    await handle.close();
    await waitClosed(handle.port);
  } catch (error) {
    try { await handle.close(); } catch { /* already closed or failed to start */ }
    throw error;
  }
});

test('apply effect disposer waits for HTTP close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-apply-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const port = await freePort();
  const { ctx, disposers } = pluginCtx();
  try {
    apply(ctx, {
      transport: 'http',
      host: '127.0.0.1',
      port,
      authMode: 'none',
      logLevel: 'error',
    });
    assert.ok(disposers.length >= 1);
    await waitListening(port);
    for (const disposer of [...disposers].reverse()) {
      await disposer();
    }
    await waitClosed(port);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
