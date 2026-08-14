/**
 * Pure status derivation over DSH state. No DSH imports beyond types, so the
 * rules are unit-testable with fixture events. The vocabulary is deliberately
 * DSH-native where DSH has a word for it ('idle', 'running', turn-end
 * reasons) and adds the bridge-level waiting states the protocol needs.
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
/** Bridge-level session status vocabulary. */
export type BridgeStatus = 'idle' | 'queued' | 'running' | 'waiting_for_user' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'max-tokens' | 'interrupted' | 'unknown';
export interface StatusInput {
    /** Whether the session is live in this process. */
    live?: boolean;
    /** The live agent's status, when live. */
    agentStatus?: 'idle' | 'running';
    /** Whether the live agent inbox holds pending messages. */
    hasPendingInbox?: boolean;
    /** Bridge-parked approvals for this session. */
    pendingApprovals: number;
    /** Bridge-parked user questions for this session. */
    pendingQuestions: number;
    /** The session event log (live or persisted). */
    events: readonly SessionEvent[];
}
/** The last turn/end reason in the log, if any. */
export declare function lastTurnEnd(events: readonly SessionEvent[]): {
    turn: number;
    reason: TurnEndReason;
} | undefined;
/** Derive the bridge status from a DSH state snapshot. */
export declare function deriveStatus(input: StatusInput): BridgeStatus;
/** One message pending in a session's inbox lists (cold fold of splice events). */
export interface PendingFold {
    nextTurn: number;
    nextStep: number;
}
/**
 * Fold the durable 'agent/inbox/spliced' events to recover pending-message
 * counts for a session that is not live (its Inbox projection is not
 * replayed into memory). Mirrors the Inbox splice semantics.
 */
export declare function foldPendingMessages(events: readonly SessionEvent[]): PendingFold;
