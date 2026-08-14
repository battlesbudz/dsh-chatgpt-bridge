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

function makeLiveAgent(id, workspacePath, extras = {}) {
  const events = extras.events ?? [];
  const inbox = extras.inbox ?? { nextTurn: [], nextStep: [], hasPending: false };
  const agent = {
    id,
    status: extras.status ?? 'idle',
    inbox,
    session: {
      id,
      header: { id, createdAt: Date.now(), cwd: workspacePath },
      events,
      requestHeader: () => undefined,
    },
    followup() {
      agent.status = extras.followupStatus ?? 'running';
      inbox.hasPending = true;
      inbox.nextTurn = inbox.nextTurn ?? [];
      inbox.nextTurn.push({ id: 'm' });
    },
    cancel() {
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
      events.push({ type: 'turn/end', seq: events.length, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
    },
  };
  return agent;
}

function makeStatefulBridge() {
  const agents = new Map();
  const created = [];
  const workspace = { ...MIX, attachSession: async () => {}, sessionIds: [] };
  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      created.push(sessionId);
      const agent = makeLiveAgent(sessionId, meta.cwd);
      agents.set(sessionId, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing) return { agent: existing };
      const agent = makeLiveAgent(resumeSessionId, MIX.path);
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };
  const persistence = {
    list: async () => [...agents.values()].map((agent) => agent.session.header),
    inspect: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) throw new Error('missing');
      return { meta: agent.session.header, events: agent.session.events };
    },
  };
  const title = { rename() {}, get: () => undefined };
  const bridge = makeBridge({
    registry: makeRegistry([workspace]),
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((agent) => agent.session), get: (id) => agents.get(id)?.session },
    persistence,
    title,
  });
  return { bridge, agents, created, workspace };
}

test('createSession uses agents.create + attachSession (Case 1 path)', async () => {
  const { bridge, created, workspace } = makeStatefulBridge();
  let attached;
  workspace.attachSession = async (id) => { attached = id; };
  const view = await bridge.createSession('ws-1', 'demo');
  assert.equal(created.length, 1);
  assert.equal(view.session_id, created[0]);
  assert.equal(attached, created[0]);
  assert.match(view.session_id, /^session-/);
});

test('startGoal returns continuation to dsh_wait_goal (Case 2)', async () => {
  const { bridge } = makeStatefulBridge();
  const out = await bridge.startGoal({ workspace: 'ws-1', goal: 'three-step optimize' });
  assert.equal(out.continuation_required, true);
  assert.equal(out.next_tool_call.name, 'dsh_wait_goal');
  assert.equal(out.next_tool_call.arguments.session_id, out.session_id);
  assert.ok(['running', 'queued'].includes(out.status));
});

test('startGoal request_id is idempotent and conflicts on different args', async () => {
  const { bridge, created } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  const retry = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  assert.equal(retry.session_id, first.session_id);
  assert.equal(created.length, 1);
  await assert.rejects(
    () => bridge.startGoal({ workspace: 'ws-1', goal: 'other', request_id: 'req-1' }),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );
  assert.equal(created.length, 1);
});

test('waitGoal still-running returns after bound with continuation (Case 3)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, true);
  assert.equal(waited.terminal, false);
  assert.ok(waited.waited_ms >= 1000);
  assert.equal(waited.next_tool_call.name, 'dsh_wait_goal');
});

test('waitGoal completed is terminal (Case 4)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.terminal, true);
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.status, 'completed');
  assert.match(waited.result.summary, /done/);
});

test('waitGoal approval does not auto-approve (Case 5)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let granted;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (outcome) => { granted = outcome; },
  });
  agents.get(started.session_id).status = 'running';
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_approval');
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.needs_user_action, true);
  assert.equal(granted, undefined);
});

test('waitGoal question does not auto-answer (Case 6)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_user');
  assert.equal(waited.continuation_required, false);
  assert.equal(answered, undefined);
});

test('approve then waitGoal can continue (Case 7)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  await bridge.approve(started.session_id, 'approval-1', 'approve');
  assert.equal(outcome, 'allowed-once');
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_approval');
});

test('answerQuestion then waitGoal can continue (Case 8)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: () => {},
  });
  await bridge.answerQuestion('question-1', started.session_id, { selected: ['A'] });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_user');
});

test('stopGoal cancels a running goal (Case 9)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
});

test('stopGoal while waiting approval fails closed (Case 10)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(outcome, 'cancelled');
  assert.equal(bridge['approvals'].has('approval-1'), false);
});

test('stopGoal while waiting for user fails closed and is idempotent (waiting_for_user)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(answered, { answers: [] });
  assert.equal(bridge['questions'].has('question-1'), false);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('stopGoal twice is idempotent (Case 11)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  await bridge.stopGoal(started.session_id);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('waitGoal on persisted session has no Goal DB (Case 12)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'completed');
  assert.equal(waited.terminal, true);
});

test('startGoal sessions stay isolated (Case 13)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const a = await bridge.startGoal({ workspace: 'ws-1', goal: 'A' });
  const b = await bridge.startGoal({ workspace: 'ws-1', goal: 'B' });
  assert.notEqual(a.session_id, b.session_id);
  agents.get(a.session_id).status = 'running';
  await bridge.stopGoal(a.session_id);
  assert.equal(agents.get(b.session_id).status, 'running');
});

test('idle wait does not treat agent.status idle as still running', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, false);
  assert.ok(waited.status === 'idle' || waited.status === 'unknown');
});
