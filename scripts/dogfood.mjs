#!/usr/bin/env node
/**
 * Real MCP dogfooding: drives the booted DSH bridge with the official MCP
 * SDK client over Streamable HTTP. Covers the acceptance loop:
 * health -> list workspaces -> create session -> send message -> poll status
 * -> get result -> follow-up -> same session continues (marker memory),
 * plus workspace boundary rejection, session isolation, list/get, long-task
 * running/cancel, and secret redaction.
 *
 * Usage: node scripts/dogfood.mjs [--workspace <id|path|title>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.DSH_CHATGPT_BRIDGE_URL ?? 'http://127.0.0.1:3456/mcp';
const TOKEN_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chatgpt-bridge.token');

function readToken() {
  if (!existsSync(TOKEN_FILE)) return '';
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✖ ${name} ${detail}`);
  }
}

function toolResult(result) {
  const text = result?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { parsed, isError: result?.isError === true };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return toolResult(result);
}

async function waitFor(client, sessionId, wanted, timeoutMs = 600000, stepMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { parsed } = await call(client, 'dsh_get_task_status', { session_id: sessionId });
    last = parsed;
    if (wanted.includes(parsed?.status)) return parsed;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`status ${JSON.stringify(last)} never reached ${wanted.join('/')}`);
}

const wsArg = process.argv.indexOf('--workspace');
const workspace = wsArg >= 0 && process.argv[wsArg + 1] ? process.argv[wsArg + 1] : undefined;

console.log('dsh-chatgpt-bridge dogfooding');
console.log('target:', BASE);
console.log('token:', readToken() ? '***present***' : '(none)');

const transport = new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: readToken() ? { headers: { Authorization: `Bearer ${readToken()}` } } : {},
});
const client = new Client({ name: 'dsh-chatgpt-bridge-dogfood', version: '0.1.0' });
await client.connect(transport);

try {
  console.log('\n[1] health');
  const health = await call(client, 'dsh_health');
  check('dsh_health returns ok', health.isError === false && health.parsed?.status === 'ok', JSON.stringify(health.parsed));
  check('no secrets in health output', !JSON.stringify(health.parsed).match(/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i), '');
  check('bridge version present', typeof health.parsed?.bridge?.version === 'string');
  check('dsh version present', typeof health.parsed?.dsh?.version === 'string');
  console.log('     dsh version:', health.parsed?.dsh?.version, '| sessions:', JSON.stringify(health.parsed?.sessions));

  console.log('\n[2] list workspaces');
  const workspaces = await call(client, 'dsh_list_workspaces');
  check('dsh_list_workspaces ok', workspaces.isError === false && Array.isArray(workspaces.parsed), '');
  console.log('     ' + (workspaces.parsed ?? []).map((w) => `${w.title} (${w.id})`).join(', '));
  const target = workspace ?? workspaces.parsed?.[0]?.title;
  check('at least one registered workspace', workspaces.parsed?.length > 0);
  if (workspaces.parsed?.length === 0) throw new Error('no workspaces - cannot continue');

  console.log('\n[3] create session (workspace boundary first)');
  const rejected = await call(client, 'dsh_create_session', { workspace: 'C:\\Users\\Public' });
  check('unregistered path rejected (Case 5)', rejected.isError === true && rejected.parsed?.error?.code === 'WORKSPACE_NOT_FOUND', JSON.stringify(rejected.parsed));
  const created = await call(client, 'dsh_create_session', {
    workspace: target,
    title: 'bridge-dogfood-A',
    initial_message: 'Remember the marker: ALPHA-731. Reply with exactly: ALPHA-731',
  });
  check('create session accepted', created.isError === false && typeof created.parsed?.session_id === 'string' && created.parsed.session_id !== '', JSON.stringify(created.parsed));
  const sessionA = created.parsed?.session_id;
  check('session bound to a workspace', typeof created.parsed?.workspace === 'string');
  check('created_at present', typeof created.parsed?.created_at === 'string');

  console.log('\n[4] first turn runs to completion');
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const statusA = await call(client, 'dsh_get_task_status', { session_id: sessionA });
  check('first turn completed', statusA.parsed?.status === 'completed', JSON.stringify(statusA.parsed));

  console.log('\n[5] get result');
  const resultA = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('result returns assistant text', typeof resultA.parsed?.assistant_text === 'string' && resultA.parsed.assistant_text.length > 0, '');
  check('result status completed', resultA.parsed?.status === 'completed');
  check('marker remembered in first turn', /ALPHA-731/.test(resultA.parsed?.assistant_text ?? ''), JSON.stringify(resultA.parsed?.assistant_text?.slice(0, 120)));
  console.log('     text:', (resultA.parsed?.assistant_text ?? '').slice(0, 160).replace(/\n/g, ' | '));

  console.log('\n[6] follow-up on the SAME session (Case 3)');
  const sent = await call(client, 'dsh_send_message', { session_id: sessionA, message: 'What marker did I give you? Reply with exactly the marker.' });
  check('follow-up accepted', sent.isError === false && sent.parsed?.accepted === true, JSON.stringify(sent.parsed));
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const resultA2 = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('second turn completed', resultA2.parsed?.status === 'completed', JSON.stringify(resultA2.parsed));
  check('same session remembers ALPHA-731 (Case 3)', /ALPHA-731/.test(resultA2.parsed?.assistant_text ?? ''), JSON.stringify(resultA2.parsed?.assistant_text?.slice(0, 160)));

  console.log('\n[7] session isolation (Case 4)');
  const createdB = await call(client, 'dsh_create_session', {
    workspace: target,
    title: 'bridge-dogfood-B',
    initial_message: 'Remember the marker: BETA-992. Reply with exactly: BETA-992',
  });
  const sessionB = createdB.parsed?.session_id;
  await waitFor(client, sessionB, ['completed', 'failed', 'cancelled']);
  await call(client, 'dsh_send_message', { session_id: sessionA, message: 'Again: what marker did I give you first? Reply with exactly the marker.' });
  await waitFor(client, sessionA, ['completed', 'failed', 'cancelled']);
  const resultA3 = await call(client, 'dsh_get_result', { session_id: sessionA });
  check('session A still says ALPHA-731 (no cross-pollution)', /ALPHA-731/.test(resultA3.parsed?.assistant_text ?? ''), JSON.stringify(resultA3.parsed?.assistant_text?.slice(0, 160)));

  console.log('\n[8] list sessions');
  const list = await call(client, 'dsh_list_sessions', { limit: 20 });
  check('dsh_list_sessions returns rows', list.isError === false && Array.isArray(list.parsed) && list.parsed.length >= 2, JSON.stringify(list.parsed));
  check('session A present in list', list.parsed?.some((s) => s.session_id === sessionA));
  check('list rows carry session_id/title/created_at', list.parsed?.every((s) => s.session_id && s.created_at));

  console.log('\n[9] get session');
  const detail = await call(client, 'dsh_get_session', { session_id: sessionA, max_items: 10, max_chars: 300 });
  check('dsh_get_session ok', detail.isError === false && detail.parsed?.session_id === sessionA, '');
  check('recent messages bounded', Array.isArray(detail.parsed?.messages) && detail.parsed.messages.length <= 10);

  console.log('\n[10] long task running -> cancel (Cases 6+7)');
  const turnBefore = (await call(client, 'dsh_get_task_status', { session_id: sessionB })).parsed?.last_turn?.turn ?? 0;
  await call(client, 'dsh_send_message', {
    session_id: sessionB,
    message: 'Use the pwsh tool to run exactly this command and wait for it: Start-Sleep -Seconds 60; Write-Output done',
  });
  // Deterministic cancel window: as soon as the new turn is OPEN (turn/start
  // logged, no turn/end yet), the driver is working and cancel aborts it.
  let turnOpened = false;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const { parsed } = await call(client, 'dsh_get_task_status', { session_id: sessionB });
    if ((parsed?.last_turn?.turn ?? 0) > turnBefore && parsed?.last_turn?.reason === undefined) {
      turnOpened = true;
      break;
    }
    if ((parsed?.last_turn?.turn ?? 0) > turnBefore && parsed?.last_turn?.reason !== undefined) break; // turn already closed
    await new Promise((r) => setTimeout(r, 250));
  }
  check('long task turn opened and ran (Case 6)', turnOpened);
  // Let the driver settle into the step (the 60s task is still executing),
  // so the cancel lands mid-turn instead of in the pre-step wake window.
  if (turnOpened) await new Promise((r) => setTimeout(r, 4000));
  const cancel = await call(client, 'dsh_cancel_task', { session_id: sessionB });
  check('cancel accepted', cancel.isError === false && cancel.parsed?.cancelled === true, JSON.stringify(cancel.parsed));
  await waitFor(client, sessionB, ['cancelled', 'completed', 'failed'], 120000);
  const statusB = await call(client, 'dsh_get_task_status', { session_id: sessionB });
  check('cancelled turn reported cancelled (Case 7)', statusB.parsed?.status === 'cancelled', JSON.stringify(statusB.parsed));

  console.log('\n[11] secret redaction in tool outputs (Case 8)');
  const health2 = await call(client, 'dsh_health', {});
  const healthText = JSON.stringify(health2.parsed);
  check('no sk- keys in health', !/sk-[A-Za-z0-9]{8,}/.test(healthText));
  check('no bearer tokens in health', !/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(healthText));
  check('health never reports the token itself', !healthText.includes(readToken()) || readToken() === '');
} finally {
  await client.close();
}

console.log('\n==== dogfood summary ====');
if (failures === 0) console.log('ALL CHECKS PASSED');
else console.log(`${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);