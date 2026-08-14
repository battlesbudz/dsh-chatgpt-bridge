/**
 * MCP server surface: the eleven dsh_* tools ChatGPT calls. Every tool maps
 * onto a Bridge operation; nothing here reaches the filesystem, the shell,
 * or DSH internals directly. Outputs are JSON text blocks; failures are
 * reported as isError results with { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Bridge, BridgeError } from './bridge.js';
import { redactValue } from './redact.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
function textResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(redactValue(value), null, 2) }] };
}
function errorResult(error) {
    if (error instanceof BridgeError) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2) }],
            isError: true,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    const stack = process.env.DSH_CHATGPT_BRIDGE_DEBUG === '1' && error instanceof Error ? error.stack : undefined;
    return {
        content: [{ type: 'text', text: JSON.stringify(stack ? { error: { code: 'INTERNAL', message, stack } } : { error: { code: 'INTERNAL', message } }, null, 2) }],
        isError: true,
    };
}
/** Wrap one async handler into the MCP error convention. */
function safe(handler) {
    return async (args) => {
        try {
            return textResult(await handler(args));
        }
        catch (error) {
            return errorResult(error);
        }
    };
}
export function createMcpServer(bridge, cfg, log) {
    const server = new McpServer({ name: BRIDGE_NAME, version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
    server.registerTool('dsh_health', {
        title: 'DSH bridge health',
        description: 'Bridge and DSH runtime status: versions, live/persisted/active session counts and ' +
            'capability flags. Never returns tokens, keys, cookies or environment secrets.',
        inputSchema: z.object({}),
    }, safe(async () => bridge.health()));
    server.registerTool('dsh_list_workspaces', {
        title: 'List registered workspaces',
        description: 'List the workspaces DSH already registered/authorized. Sessions can only be created ' +
            'inside these. Arbitrary paths are never opened or auto-registered.',
        inputSchema: z.object({}),
    }, safe(async () => bridge.listWorkspaces()));
    server.registerTool('dsh_create_session', {
        title: 'Create a DSH session',
        description: 'Create a real DSH agent session bound to a registered workspace (id, canonical path, or ' +
            'title from dsh_list_workspaces). The agent starts immediately; if initial_message is ' +
            'given the first turn begins right away. Returns the stable session_id to continue later.',
        inputSchema: z.object({
            workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
            title: z.string().optional().describe('Optional display title for the session'),
            initial_message: z.string().optional().describe('Optional first message for the agent'),
        }),
    }, safe(async (args) => bridge.createSession(args.workspace, args.title, args.initial_message)));
    server.registerTool('dsh_list_sessions', {
        title: 'List DSH sessions',
        description: 'List sessions (live + persisted), newest first, with limited paging. DSH persistence is ' +
            'the authority: sessions survive bridge and ChatGPT restarts and can be continued by id.',
        inputSchema: z.object({
            limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 50)'),
            offset: z.number().int().min(0).optional().describe('Skip this many rows (default 0)'),
            workspace: z.string().optional().describe('Filter to one registered workspace'),
        }),
    }, safe(async (args) => bridge.listSessions({ limit: args.limit, offset: args.offset, workspace: args.workspace })));
    server.registerTool('dsh_get_session', {
        title: 'Inspect one DSH session',
        description: 'Status, workspace, recent message summary (bounded), agent state, pending work, ' +
            'waiting approvals/questions and todos for one session. History is budgeted, never unlimited.',
        inputSchema: z.object({
            session_id: z.string().min(1),
            max_items: z.number().int().min(1).max(200).optional().describe('Max message rows'),
            max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars per message'),
        }),
    }, safe(async (args) => bridge.getSession(args.session_id, args.max_items, args.max_chars)));
    server.registerTool('dsh_send_message', {
        title: 'Send a message to a DSH session',
        description: 'Continue an EXISTING DSH session: the message joins that session\'s durable log and the ' +
            'same agent loop (never a fresh agent). Returns immediately; poll ' +
            'dsh_get_task_status / dsh_get_result for progress. Long tasks run in the background.',
        inputSchema: z.object({
            session_id: z.string().min(1),
            message: z.string().min(1).max(20000),
        }),
    }, safe(async (args) => bridge.sendMessage(args.session_id, args.message)));
    server.registerTool('dsh_get_task_status', {
        title: 'Task status of one session',
        description: 'Status vocabulary: idle, queued, running, waiting_for_user, waiting_for_approval, ' +
            'completed, failed, cancelled, blocked, max-tokens, interrupted. Also reports pending ' +
            'inbox items and any waiting approvals/questions with their ids.',
        inputSchema: z.object({ session_id: z.string().min(1) }),
    }, safe(async (args) => bridge.getTaskStatus(args.session_id)));
    server.registerTool('dsh_get_result', {
        title: 'Final result of the last turn',
        description: 'Last turn\'s assistant text, status, tool calls, changed files (from the session log, ' +
            'not guessed) and structured error when the turn failed.',
        inputSchema: z.object({
            session_id: z.string().min(1),
            max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars of assistant text'),
        }),
    }, safe(async (args) => bridge.getResult(args.session_id, args.max_chars)));
    server.registerTool('dsh_cancel_task', {
        title: 'Cancel the running task',
        description: 'Cancel the active turn of a live session through DSH\'s own cancel mechanism ' +
            '(agent.cancel). No processes are killed; the turn ends with an aborted reason.',
        inputSchema: z.object({ session_id: z.string().min(1) }),
    }, safe(async (args) => bridge.cancelTask(args.session_id)));
    server.registerTool('dsh_answer_question', {
        title: 'Answer a pending user question',
        description: 'Answer a question the DSH agent asked the human (status waiting_for_user). Pass the ' +
            'question_id from dsh_get_task_status, one or more offered option labels, and optional ' +
            'free text.',
        inputSchema: z.object({
            question_id: z.string().min(1),
            session_id: z.string().optional(),
            selected: z.array(z.string()).default([]),
            custom: z.string().optional(),
        }),
    }, safe(async (args) => bridge.answerQuestion(args.question_id, args.session_id, { selected: args.selected, custom: args.custom })));
    server.registerTool('dsh_approve', {
        title: 'Decide one pending approval',
        description: 'Decide one explicit DSH permission approval (status waiting_for_approval). Requires the ' +
            'exact approval_id and an explicit approve/reject decision. There is no approve-all; ' +
            'every grant is allowed-once for the exact tool call. Rejecting fails the call closed.',
        inputSchema: z.object({
            session_id: z.string().min(1),
            approval_id: z.string().min(1),
            decision: z.enum(['approve', 'reject']),
        }),
    }, safe(async (args) => bridge.approve(args.session_id, args.approval_id, args.decision)));
    return server;
}
