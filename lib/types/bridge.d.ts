import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type BridgeStatus } from './status.js';
import { type MessageRow, type ToolCallInfo } from './session-view.js';
/** Typed bridge error with a stable machine-readable code. */
export declare class BridgeError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
    id: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
    resolve: (outcome: ApprovalOutcome) => void;
}
/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
    id: string;
    sessionId?: string;
    questions: AskUserQuestionItem[];
    resolve: (answer: AskUserQuestionAnswer) => void;
}
/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
    approval_id: string;
    session_id: string;
    tool_name: string;
    call_id?: string;
    reason?: string;
}
/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
    question_id: string;
    session_id?: string;
    questions: AskUserQuestionItem[];
}
export interface WaitingState {
    approvals: ApprovalSummary[];
    questions: QuestionSummary[];
}
export interface HealthReport {
    status: string;
    bridge: {
        name: string;
        version: string;
    };
    dsh: {
        version: string;
    };
    runtime: {
        pid: number;
        uptimeMs: number;
    };
    sessions: {
        live: number;
        persisted: number;
        active: number;
    };
    capabilities: {
        transports: string[];
        authMode: 'token' | 'none';
        workspaceRegistry: boolean;
        sessionPersistence: boolean;
        agentPresets: boolean;
        userQuestions: boolean;
        approvals: boolean;
        workspaces: number;
    };
}
export interface WorkspaceView {
    id: string;
    title: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    sessionCount: number;
}
export interface SessionView {
    session_id: string;
    title?: string;
    workspace?: string;
    status: BridgeStatus;
    created_at: string;
    updated_at?: string;
    agent?: {
        status: 'idle' | 'running';
        inbox: {
            nextTurn: number;
            nextStep: number;
        };
    };
    pending: {
        nextTurn: number;
        nextStep: number;
    };
    waiting: WaitingState;
    messages: MessageRow[];
    last_turn?: {
        turn: number;
        reason?: string;
    };
    todos?: {
        content: string;
        status: string;
    }[];
}
export interface SessionSummary {
    session_id: string;
    title?: string;
    workspace?: string;
    status?: BridgeStatus;
    created_at: string;
    updated_at?: string;
}
export interface ResultView {
    session_id: string;
    status: BridgeStatus;
    turn: number;
    summary: string;
    assistant_text: string;
    changed_files: string[];
    tool_calls: ToolCallInfo[];
    error?: {
        code: string;
        message: string;
    };
}
/** DSH version string, resolved lazily from the installed package. */
export declare function dshVersion(): string;
/** Normalize a path for comparison (case-insensitive on win32). */
export declare function normalizePath(path: string): string;
/** The bridge service. One instance per plugin activation. */
export declare class Bridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    /** Sessions created through this bridge (approval answering scope). */
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private questionSeq;
    private approvalsEnabled;
    private questionsEnabled;
    private started;
    constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger);
    /** Register the approval answerer and the user-questions provider. */
    start(): void;
    /** Count of bridge-created sessions still live. */
    managedCount(): number;
    private agentOptions;
    /** Agent-scoped model selection with log-derived fallback for resumes. */
    private installSelection;
    /** Compose the preset+selection setup used at agent creation/resume. */
    private composeSetupFor;
    private loadView;
    /** Resolve a live agent, resuming the persisted session when needed. */
    private ensureAgent;
    listWorkspaces(): Promise<WorkspaceView[]>;
    /**
     * Resolve a workspace reference (id, canonical path, or title) against the
     * REGISTERED workspace set only. Never auto-registers and never opens an
     * arbitrary path: an unregistered path is rejected.
     */
    resolveWorkspace(input: string): Promise<Workspace>;
    health(): Promise<HealthReport>;
    createSession(workspaceInput: string, title?: string, initialMessage?: string): Promise<SessionView>;
    sendMessage(sessionId: string, message: string): Promise<{
        session_id: string;
        accepted: boolean;
    }>;
    cancelTask(sessionId: string): Promise<{
        session_id: string;
        cancelled: boolean;
    }>;
    private waitingFor;
    private statusOf;
    private titleOf;
    private viewOf;
    getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView>;
    listSessions(options: {
        limit?: number;
        offset?: number;
        workspace?: string;
    }): Promise<SessionSummary[]>;
    /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
    private cachedTitle;
    getResult(sessionId: string, maxChars?: number): Promise<ResultView>;
    getTaskStatus(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        live: boolean;
        agent_status?: 'idle' | 'running';
        pending: {
            nextTurn: number;
            nextStep: number;
        };
        waiting: WaitingState;
        last_turn?: {
            turn: number;
            reason?: string;
        };
        updated_at?: string;
    }>;
    answerQuestion(questionId: string, sessionId: string | undefined, answer: {
        selected: string[];
        custom?: string;
    }): Promise<{
        answered: true;
    }>;
    approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
        approval_id: string;
        session_id: string;
        decision: 'approve' | 'reject';
        outcome: ApprovalOutcome;
    }>;
    listManaged(): string[];
}
