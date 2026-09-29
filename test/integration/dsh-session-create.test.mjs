import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session';
import { Bridge } from '../../lib/bridge.js';

test('bridge creates and registers a top-level session with the DSH 0.1.5 agent/session APIs', async () => {
  const ctx = new Context();
  const agents = new AgentRegistry(ctx);
  const workspace = {
    id: 'workspace-test',
    title: 'test workspace',
    path: '/tmp/dsh-bridge-session-test',
    createdAt: 1,
    updatedAt: 1,
    sessionIds: [],
    async attachSession(id) { this.sessionIds.push(id); },
  };
  ctx.provide('workspaceRegistry', { list: () => [workspace] });

  agents.setFactory({
    async createAgent(ownerCtx, options) {
      const agentCtx = ownerCtx.extend();
      const session = Session.create(options.sessionId, undefined, {
        version: SESSION_FORMAT_VERSION,
        id: options.sessionId,
        createdAt: Date.now(),
        cwd: options.meta.cwd,
        isSeeded: false,
        ...(options.meta.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
      });
      const agent = {
        id: options.sessionId,
        session,
        ctx: agentCtx,
        options: options.agentOptions,
        status: 'idle',
        inbox: { nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {}, replace() { return false; }, discard() { return false; } },
        followup() {},
        cancel() {},
      };
      await options.setup?.(agentCtx, agent);
      agents.register(agent);
      return { agent, async dispose() {} };
    },
    async resume() { throw new Error('resume is outside this creation test'); },
  });

  const bridge = new Bridge(ctx, {
    sessionMaxItems: 5,
    sessionMaxChars: 200,
    resultMaxItems: 10,
    resultMaxChars: 500,
  }, { debug() {}, info() {}, warn() {}, error() {} });
  const created = await bridge.createSession(workspace.id);

  assert.equal(created.status, 'idle');
  assert.equal(agents.get(SessionId(created.session_id))?.session.header.cwd, workspace.path);
  assert.deepEqual(workspace.sessionIds, [SessionId(created.session_id)]);
});
