import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOperatorTools } from '../../lib/operator-mcp.js';
import { shouldInvalidatePendingApproval } from '../../lib/operator-contract.js';

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, _definition, handler) { tools.set(name, handler); },
  };
}

test('goal action changes invalidate obsolete approvals', () => {
  assert.equal(shouldInvalidatePendingApproval('revise'), true);
  assert.equal(shouldInvalidatePendingApproval('defer'), true);
  assert.equal(shouldInvalidatePendingApproval('resume'), true);
  assert.equal(shouldInvalidatePendingApproval('start'), false);
});

test('delegate_goal injects English operator contract and autonomous engineering loop', async () => {
  const server = fakeServer();
  let captured;
  const bridge = {
    async startGoal(input) { captured = input; return { session_id: 's1', status: 'running', continuation_required: true }; },
    async getResult() { throw new Error('unused'); },
    async getTaskStatus() { throw new Error('unused'); },
  };
  registerOperatorTools(server, bridge);
  const handler = server.tools.get('dsh_delegate_goal');
  const response = await handler({ workspace: 'repo', goal: 'Fix the bug', plan: 'Stay in scope' });
  assert.equal(captured.workspace, 'repo');
  assert.match(captured.plan, /English/);
  assert.match(captured.plan, /feature branch/i);
  assert.match(captured.plan, /build/i);
  assert.match(captured.plan, /test/i);
  const body = JSON.parse(response.content[0].text);
  assert.equal(body.operator_language, 'en-US');
});

test('review_handoff derives receipt from DSH evidence and remains independently reviewable', async () => {
  const server = fakeServer();
  const bridge = {
    async startGoal() { throw new Error('unused'); },
    async getResult() {
      return {
        session_id: 's1',
        status: 'completed',
        turn: 2,
        summary: 'Done',
        assistant_text: 'Done',
        changed_files: ['fallback.ts'],
        tool_calls: [
          { callId: '1', name: 'write', arguments: '{}', isError: false },
          { callId: '2', name: 'test', arguments: '{}', isError: false },
        ],
        result_schema: {
          status: 'completed',
          goal: { goal_id: 'g1', revision: 2, workspace: 'repo', card: 'Goal rev 2', revision_history_folded: true, revision_history: [] },
          tests: { total: 1, pass: 1, fail: 0, skip: 0, suites: ['npm test'], evidence_ids: ['ev1'] },
          changes: { changed_files: ['src/a.ts'], commits: ['abc1234'], tags: [], working_tree: 'clean' },
          artifacts: [],
          remote: {},
          security: { secret_leak_check: true, credential_refs: [] },
          warnings: [],
          provenance: { session_id: 's1', goal_id: 'g1' },
        },
      };
    },
    async getTaskStatus() {
      return { session_id: 's1', status: 'completed', live: true, pending: { nextTurn: 0, nextStep: 0 }, waiting: { approvals: [], questions: [] }, goal: { revision: 2 } };
    },
  };
  registerOperatorTools(server, bridge);
  const response = await server.tools.get('dsh_review_handoff')({ session_id: 's1' });
  const body = JSON.parse(response.content[0].text);
  assert.deepEqual(body.receipt.changed_files, ['src/a.ts']);
  assert.deepEqual(body.receipt.commits, ['abc1234']);
  assert.equal(body.receipt.tests[0].status, 'passed');
  assert.equal(body.receipt.review_ready, true);
  assert.match(body.review_instruction, /Independently inspect/);
});
