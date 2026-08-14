import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, redactMessage } from '../../lib/redact.js';

test('redactText masks OpenAI-style keys (Case 8: sk-test-DO-NOT-LOG)', () => {
  const out = redactText('the key is sk-test-DO-NOT-LOG-1234567890 and more');
  assert.equal(out.includes('sk-test-DO-NOT-LOG'), false);
  assert.ok(out.includes('[REDACTED]'));
});

test('redactText masks bearer tokens', () => {
  const out = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 end');
  assert.equal(out.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
});

test('redactText masks key=value assignments', () => {
  assert.equal(redactText('api_key=super-secret-value-12345'), '[REDACTED]');
  const out = redactText('DEEPSEEK_API_KEY: sk-abcdefghijklmnop');
  assert.ok(!out.includes('sk-abcdefghijklmnop'), 'value must be masked');
  assert.ok(out.includes('[REDACTED]'));
});

test('redactValue replaces secret-shaped keys wholesale', () => {
  const out = redactValue({ authorization: 'Bearer abc123', data: { cookie: 'sid=xyz', ok: 'fine', token: 'tok-999' } });
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.data.cookie, '[REDACTED]');
  assert.equal(out.data.token, '[REDACTED]');
  assert.equal(out.data.ok, 'fine');
});

test('redactValue walks arrays', () => {
  const out = redactValue([{ password: 'hunter2' }, 'sk-abcdefghijklmnopqrstuvwxyz']);
  assert.equal(out[0].password, '[REDACTED]');
  assert.ok(!out[1].includes('sk-abcdefghijklmnopqrstuvwxyz'));
});

test('redactMessage keeps message and redacts payload', () => {
  const line = redactMessage('failed to auth', { token: 'abc123' });
  assert.ok(line.startsWith('failed to auth'));
  assert.ok(line.includes('[REDACTED]'));
  assert.ok(!line.includes('abc123'));
});