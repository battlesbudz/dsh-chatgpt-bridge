import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, BridgeError } from '../../lib/bridge.js';

// A minimal fake workspace registry with one registered workspace.
function makeRegistry(workspaces) {
  return {
    list: () => workspaces,
  };
}

const MIX = { id: 'ws-1', title: 'mix_workspace', path: 'D:\\Agent\\agent_workplace\\mix_workspace', createdAt: 'x', updatedAt: 'x', sessionIds: [] };
const OTHER = { id: 'ws-2', title: 'other', path: 'D:\\Other\\place', createdAt: 'x', updatedAt: 'x', sessionIds: [] };

function makeBridge({ registry, agents, sessions, persistence, on, userQuestions, title } = {}) {
  const services = {
    workspaceRegistry: registry,
    agents: agents ?? { get: () => undefined, list: () => [] },
    sessions: sessions ?? { list: () => [], get: () => undefined },
    sessionPersistence: persistence ?? { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: title,
    on: on ?? (() => {}),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
}

test('resolveWorkspace: accepts id, canonical path, and title (Case 5 boundary)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX, OTHER]) });
  assert.equal((await bridge.resolveWorkspace('ws-1')).path, MIX.path);
  assert.equal((await bridge.resolveWorkspace(MIX.path)).id, 'ws-1');
  assert.equal((await bridge.resolveWorkspace('mix_workspace')).id, 'ws-1');
});

test('resolveWorkspace: rejects unregistered paths (Case 5)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX]) });
  for (const input of ['D:\\Users\\nobody\\secret', 'C:\\Windows', '/', 'D:\\', '~']) {
    await assert.rejects(() => bridge.resolveWorkspace(input), (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    });
  }
});

test('resolveWorkspace: rejects when no registry is mounted', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.resolveWorkspace('anything'), (error) => {
    assert.equal(error.code, 'WORKSPACE_REGISTRY_UNAVAILABLE');
    return true;
  });
});

test('approve: rejects unknown approval ids', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.approve('session-1', 'approval-nope', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_NOT_FOUND');
    return true;
  });
});

test('approve: rejects session mismatch', async () => {
  const bridge = makeBridge({});
  const settled = { resolve: () => {} };
  bridge['approvals'].set('approval-1', { id: 'approval-1', sessionId: 'session-a', toolName: 't', resolve: (o) => settled.resolve(o) });
  await assert.rejects(() => bridge.approve('session-b', 'approval-1', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_SESSION_MISMATCH');
    return true;
  });
});

test('answerQuestion: rejects unknown question ids and invalid selections', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.answerQuestion('question-9', undefined, { selected: [] }), (error) => {
    assert.equal(error.code, 'QUESTION_NOT_FOUND');
    return true;
  });
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    resolve: () => {},
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['Z'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['A', 'B'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
});

test('answerQuestion: resolves with the offered option', async () => {
  const bridge = makeBridge({});
  let resolved;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { resolved = answer; },
  });
  const out = await bridge.answerQuestion('question-1', 'session-a', { selected: ['A'] });
  assert.deepEqual(out, { answered: true });
  assert.deepEqual(resolved.answers, [{ id: 'inner-1', selected: ['A'] }]);
});

test('cancelTask: only live sessions can be cancelled', async () => {
  const bridge = makeBridge({ agents: { get: () => undefined } });
  await assert.rejects(() => bridge.cancelTask('session-1'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_LIVE');
    return true;
  });
});

test('sendMessage: empty message rejected', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.sendMessage('session-1', '   '), (error) => {
    assert.equal(error.code, 'EMPTY_MESSAGE');
    return true;
  });
});

test('sendMessage: unknown session rejected', async () => {
  const bridge = makeBridge({ persistence: { inspect: async () => { throw new Error('nope'); } } });
  await assert.rejects(() => bridge.sendMessage('session-unknown', 'hello'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
});
