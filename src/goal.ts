/**
 * Thin Goal Supervision mapper. No Goal DB: maps existing DSH session
 * status (deriveStatus) into the start/wait/stop continuation protocol.
 */
import type { BridgeStatus } from './status.js';

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

export function clampWaitSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAIT_SECONDS;
  const n = Math.trunc(value);
  if (n < MIN_WAIT_SECONDS) return MIN_WAIT_SECONDS;
  if (n > MAX_WAIT_SECONDS) return MAX_WAIT_SECONDS;
  return n;
}

export function buildGoalMessage(goal: string, plan?: string): string {
  const lines = [`Goal:\n${goal.trim()}`];
  if (plan !== undefined && plan.trim() !== '') lines.push(`Plan:\n${plan.trim()}`);
  lines.push(GOAL_MODE);
  return lines.join('\n\n');
}

export function titleFromGoal(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
  if (line.length <= 80) return line;
  return line.slice(0, 79) + '…';
}

export function fingerprintStart(input: {
  workspace: string;
  goal: string;
  plan?: string;
  session_id?: string;
}): string {
  return JSON.stringify({
    workspace: input.workspace,
    goal: input.goal,
    plan: input.plan ?? '',
    session_id: input.session_id ?? '',
  });
}

/** Only these statuses keep the Goal wait loop alive. Never treat idle as running. */
export function isActiveStatus(status: BridgeStatus): boolean {
  return status === 'running' || status === 'queued';
}

export function isTerminalStatus(status: BridgeStatus): boolean {
  return (
    status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'blocked'
    || status === 'max-tokens'
    || status === 'interrupted'
  );
}

export function isWaitingStatus(status: BridgeStatus): boolean {
  return status === 'waiting_for_approval' || status === 'waiting_for_user';
}

export interface GoalToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GoalProgress {
  todos: { content: string; status: string }[];
  todos_completed: number;
  todos_total: number;
  agent_status?: 'idle' | 'running';
  last_activity?: string;
  last_turn?: { turn: number; reason?: string };
  changed_files: string[];
  error_summary?: string;
}

export interface GoalResult {
  summary: string;
  changed_files: string[];
  todos: { content: string; status: string }[];
}

export interface GoalStartResult {
  session_id: string;
  status: BridgeStatus;
  continuation_required: boolean;
  next_action: string;
  next_tool_call?: GoalToolCall;
}

export interface GoalWaitResult {
  session_id: string;
  status: BridgeStatus;
  terminal: boolean;
  waited_ms: number;
  continuation_required: boolean;
  needs_user_action?: boolean;
  progress?: GoalProgress;
  result?: GoalResult;
  approval?: unknown;
  question?: unknown;
  next_action: string;
  next_tool_call?: GoalToolCall;
}

export interface GoalSnapshot {
  sessionId: string;
  status: BridgeStatus;
  waitedMs: number;
  waitSeconds: number;
  todos?: { content: string; status: string }[];
  lastActivity?: string;
  lastTurn?: { turn: number; reason?: string };
  changedFiles: string[];
  assistantSummary: string;
  errorSummary?: string;
  agentStatus?: 'idle' | 'running';
  approval?: unknown;
  question?: unknown;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

function boundedTodos(todos: { content: string; status: string }[] | undefined): { content: string; status: string }[] {
  return (todos ?? []).slice(0, GOAL_TODOS_MAX);
}

function boundedFiles(files: string[]): string[] {
  return files.slice(0, GOAL_FILES_MAX);
}

function progressOf(snapshot: GoalSnapshot): GoalProgress {
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

export function mapStartGoal(sessionId: string, status: BridgeStatus, waitSeconds = DEFAULT_WAIT_SECONDS): GoalStartResult {
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

export function mapWaitGoal(snapshot: GoalSnapshot): GoalWaitResult {
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

export interface GoalRequestRecord {
  sessionId: string;
  fingerprint: string;
}

/** FIFO-capped in-memory request_id map. Not durable across process restarts. */
export class RequestIdMap {
  private readonly items = new Map<string, GoalRequestRecord>();
  private readonly cap: number;
  constructor(cap = REQUEST_ID_CAP) {
    this.cap = cap;
  }

  get(requestId: string): GoalRequestRecord | undefined {
    return this.items.get(requestId);
  }

  set(requestId: string, record: GoalRequestRecord): void {
    if (this.items.has(requestId)) this.items.delete(requestId);
    this.items.set(requestId, record);
    while (this.items.size > this.cap) {
      const first = this.items.keys().next().value;
      if (first === undefined) break;
      this.items.delete(first);
    }
  }
}
