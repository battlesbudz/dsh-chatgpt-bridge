import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asApiProxy, compositionHasWebGateway, respondApproval, cancelQuestion } from '../../lib/web-gateway.js';

test('compositionHasWebGateway sees api-gateway before it starts', () => {
  assert.equal(compositionHasWebGateway({ get: () => undefined }), false);
  assert.equal(compositionHasWebGateway({
    get: () => ({ entries: () => [{ id: 'workspace', options: { name: '@deepseek-ai/dsh-workspace' } }] }),
  }), false);
  assert.equal(compositionHasWebGateway({
    get: (name) => name === 'loader'
      ? { entries: () => [{ id: 'api-gateway', options: { id: 'api-gateway', name: '@deepseek-ai/dsh-host-apiproxy' } }] }
      : undefined,
  }), true);
});

test('asApiProxy accepts only mux+respond shapes', () => {
  assert.equal(asApiProxy(undefined), undefined);
  assert.equal(asApiProxy({}), undefined);
  assert.equal(asApiProxy({ respond: () => {}, events: {} }), undefined);
  const api = { respond: async () => ({ accepted: true }), events: { mux: async function* () {} } };
  assert.equal(asApiProxy(api), api);
});

test('respond helpers use the official client-response envelope', async () => {
  const seen = [];
  const api = {
    events: { mux: async function* () {} },
    respond: async (message) => { seen.push(message); return { accepted: true }; },
  };
  await respondApproval(api, 'rpc-1', 'session-1', 'appr-1', 'rejected');
  await cancelQuestion(api, 'rpc-2');
  assert.equal(seen[0].type, 'client-response');
  assert.equal(seen[0].result.ok, true);
  assert.equal(seen[0].result.value.outcome, 'rejected');
  assert.equal(seen[1].result.ok, false);
  assert.equal(seen[1].result.error.code, 'cancelled');
});
