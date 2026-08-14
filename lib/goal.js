export const DEFAULT_WAIT_SECONDS = 25;
export const MIN_WAIT_SECONDS = 1;
export const MAX_WAIT_SECONDS = 30;
export const WAIT_POLL_MS = 500;
export const REQUEST_ID_CAP = 256;
export const GOAL_SUMMARY_MAX_CHARS = 4000;
export const GOAL_FILES_MAX = 40;
export const GOAL_TODOS_MAX = 40;
const GOAL_MODE = [
    'Goal execution mode:',
    '- Treat the supplied goal as the completion target.',
    '- Use DSH native todos to track progress.',
    '- Continue working through remaining todos without waiting for ChatGPT between ordinary engineering steps.',
    '- Pause only for user questions, approvals, explicit errors, cancellation, or when the goal is complete.',
    '- Do not expand scope beyond the supplied goal.',
].join('\n');
export function clampWaitSeconds(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_WAIT_SECONDS;
    const n = Math.trunc(value);
    if (n < MIN_WAIT_SECONDS)
        return MIN_WAIT_SECONDS;
    if (n > MAX_WAIT_SECONDS)
        return MAX_WAIT_SECONDS;
    return n;
}
export function buildGoalMessage(goal, plan) {
    const lines = [`Goal:\n${goal.trim()}`];
    if (plan !== undefined && plan.trim() !== '')
        lines.push(`Plan:\n${plan.trim()}`);
    lines.push(GOAL_MODE);
    return lines.join('\n\n');
}
export function titleFromGoal(goal) {
    const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
    if (line.length <= 80)
        return line;
    return line.slice(0, 79) + '…';
}
export function fingerprintStart(input) {
    return JSON.stringify({
        workspace: input.workspace,
        goal: input.goal,
        plan: input.plan ?? '',
        session_id: input.session_id ?? '',
    });
}
/** Only these statuses keep the Goal wait loop alive. Never treat idle as running. */
export function isActiveStatus(status) {
    return status === 'running' || status === 'queued';
}
export function isTerminalStatus(status) {
    return (status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'blocked'
        || status === 'max-tokens'
        || status === 'interrupted');
}
export function isWaitingStatus(status) {
    return status === 'waiting_for_approval' || status === 'waiting_for_user';
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '…[truncated]';
}
function boundedTodos(todos) {
    return (todos ?? []).slice(0, GOAL_TODOS_MAX);
}
function boundedFiles(files) {
    return files.slice(0, GOAL_FILES_MAX);
}
function progressOf(snapshot) {
    const todos = boundedTodos(snapshot.todos);
    return {
        todos,
        todos_completed: todos.filter((todo) => todo.status === 'completed').length,
        todos_total: todos.length,
        ...(snapshot.agentStatus === undefined ? {} : { agent_status: snapshot.agentStatus }),
        ...(snapshot.lastActivity === undefined ? {} : { last_activity: snapshot.lastActivity }),
        ...(snapshot.lastTurn === undefined ? {} : { last_turn: snapshot.lastTurn }),
        changed_files: boundedFiles(snapshot.changedFiles),
        ...(snapshot.errorSummary === undefined || snapshot.errorSummary === ''
            ? {}
            : { error_summary: truncate(snapshot.errorSummary, 500) }),
    };
}
export function mapStartGoal(sessionId, status, waitSeconds = DEFAULT_WAIT_SECONDS) {
    const active = isActiveStatus(status);
    if (active) {
        return {
            session_id: sessionId,
            status,
            continuation_required: true,
            next_action: 'Continue supervising this DSH goal. Call dsh_wait_goal immediately in this assistant turn.',
            next_tool_call: {
                name: 'dsh_wait_goal',
                arguments: { session_id: sessionId, wait_seconds: waitSeconds },
            },
        };
    }
    if (isWaitingStatus(status)) {
        return {
            session_id: sessionId,
            status,
            continuation_required: false,
            next_action: status === 'waiting_for_approval'
                ? 'DSH is waiting for an explicit approval. Ask the user, then call dsh_approve, then dsh_wait_goal.'
                : 'DSH is waiting for the user. Ask the user, then call dsh_answer_question, then dsh_wait_goal.',
        };
    }
    return {
        session_id: sessionId,
        status,
        continuation_required: false,
        next_action: isTerminalStatus(status)
            ? 'The DSH goal is already terminal. Inspect the session or start a new goal.'
            : 'The DSH session is idle. Send a goal or message before waiting.',
    };
}
export function mapWaitGoal(snapshot) {
    const { sessionId, status, waitedMs, waitSeconds } = snapshot;
    if (isActiveStatus(status)) {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: true,
            progress: progressOf(snapshot),
            next_action: 'DSH is still working. Call dsh_wait_goal again immediately in this assistant turn; do not tell the user the task is merely running in the background.',
            next_tool_call: {
                name: 'dsh_wait_goal',
                arguments: { session_id: sessionId, wait_seconds: waitSeconds },
            },
        };
    }
    if (status === 'waiting_for_approval') {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: false,
            needs_user_action: true,
            ...(snapshot.approval === undefined ? {} : { approval: snapshot.approval }),
            progress: progressOf(snapshot),
            next_action: 'DSH is waiting for approval. Ask the user, then call dsh_approve with the exact approval_id, then call dsh_wait_goal. Do not auto-approve.',
        };
    }
    if (status === 'waiting_for_user') {
        return {
            session_id: sessionId,
            status,
            terminal: false,
            waited_ms: waitedMs,
            continuation_required: false,
            needs_user_action: true,
            ...(snapshot.question === undefined ? {} : { question: snapshot.question }),
            progress: progressOf(snapshot),
            next_action: 'DSH is waiting for the user. Ask the user, then call dsh_answer_question, then call dsh_wait_goal. Do not guess the answer.',
        };
    }
    if (isTerminalStatus(status)) {
        return {
            session_id: sessionId,
            status,
            terminal: true,
            waited_ms: waitedMs,
            continuation_required: false,
            result: {
                summary: truncate(snapshot.assistantSummary, GOAL_SUMMARY_MAX_CHARS),
                changed_files: boundedFiles(snapshot.changedFiles),
                todos: boundedTodos(snapshot.todos),
            },
            ...(snapshot.errorSummary === undefined || snapshot.errorSummary === ''
                ? {}
                : { progress: progressOf(snapshot) }),
            next_action: status === 'completed'
                ? 'The DSH goal is complete. Review the returned result.'
                : `The DSH goal ended (${status}). Review the returned result; do not keep calling dsh_wait_goal.`,
        };
    }
    return {
        session_id: sessionId,
        status,
        terminal: false,
        waited_ms: waitedMs,
        continuation_required: false,
        progress: progressOf(snapshot),
        next_action: 'The DSH session is idle. Do not loop dsh_wait_goal; send a new goal or message if more work is needed.',
    };
}
/** FIFO-capped in-memory request_id map. Not durable across process restarts. */
export class RequestIdMap {
    items = new Map();
    cap;
    constructor(cap = REQUEST_ID_CAP) {
        this.cap = cap;
    }
    get(requestId) {
        return this.items.get(requestId);
    }
    set(requestId, record) {
        if (this.items.has(requestId))
            this.items.delete(requestId);
        this.items.set(requestId, record);
        while (this.items.size > this.cap) {
            const first = this.items.keys().next().value;
            if (first === undefined)
                break;
            this.items.delete(first);
        }
    }
}
