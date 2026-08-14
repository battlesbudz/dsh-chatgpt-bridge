/**
 * Thin Goal Supervision mapper. No Goal DB: maps existing DSH session
 * status (deriveStatus) into the start/wait/stop continuation protocol.
 */
import type { BridgeStatus } from './status.js';
export declare const DEFAULT_WAIT_SECONDS = 25;
export declare const MIN_WAIT_SECONDS = 1;
export declare const MAX_WAIT_SECONDS = 30;
export declare const WAIT_POLL_MS = 500;
export declare const REQUEST_ID_CAP = 256;
export declare const GOAL_SUMMARY_MAX_CHARS = 4000;
export declare const GOAL_FILES_MAX = 40;
export declare const GOAL_TODOS_MAX = 40;
export declare function clampWaitSeconds(value: number | undefined): number;
export declare function buildGoalMessage(goal: string, plan?: string): string;
export declare function titleFromGoal(goal: string): string;
export declare function fingerprintStart(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
}): string;
/** Only these statuses keep the Goal wait loop alive. Never treat idle as running. */
export declare function isActiveStatus(status: BridgeStatus): boolean;
export declare function isTerminalStatus(status: BridgeStatus): boolean;
export declare function isWaitingStatus(status: BridgeStatus): boolean;
export interface GoalToolCall {
    name: string;
    arguments: Record<string, unknown>;
}
export interface GoalProgress {
    todos: {
        content: string;
        status: string;
    }[];
    todos_completed: number;
    todos_total: number;
    agent_status?: 'idle' | 'running';
    last_activity?: string;
    last_turn?: {
        turn: number;
        reason?: string;
    };
    changed_files: string[];
    error_summary?: string;
}
export interface GoalResult {
    summary: string;
    changed_files: string[];
    todos: {
        content: string;
        status: string;
    }[];
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
    todos?: {
        content: string;
        status: string;
    }[];
    lastActivity?: string;
    lastTurn?: {
        turn: number;
        reason?: string;
    };
    changedFiles: string[];
    assistantSummary: string;
    errorSummary?: string;
    agentStatus?: 'idle' | 'running';
    approval?: unknown;
    question?: unknown;
}
export declare function mapStartGoal(sessionId: string, status: BridgeStatus, waitSeconds?: number): GoalStartResult;
export declare function mapWaitGoal(snapshot: GoalSnapshot): GoalWaitResult;
export interface GoalRequestRecord {
    sessionId: string;
    fingerprint: string;
}
/** FIFO-capped in-memory request_id map. Not durable across process restarts. */
export declare class RequestIdMap {
    private readonly items;
    private readonly cap;
    constructor(cap?: number);
    get(requestId: string): GoalRequestRecord | undefined;
    set(requestId: string, record: GoalRequestRecord): void;
}
