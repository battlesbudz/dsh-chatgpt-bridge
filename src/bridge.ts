/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { redactText } from './redact.js';
import {
  deriveStatus,
  foldPendingMessages,
  openAskUserQuestions,
  undecidedApprovals,
  type BridgeStatus,
} from './status.js';
import {
  assistantTextForTurn,
  changedFilesForTurn,
  lastEventTime,
  lastTurnSpan,
  summarizeMessages,
  toolCallsForTurn,
  type MessageRow,
  type ToolCallInfo,
} from './session-view.js';
import {
  DEFAULT_WAIT_SECONDS,
  RequestIdMap,
  WAIT_POLL_MS,
  buildSupervisedGoalContext,
  clampWaitSeconds,
  executionView,
  fingerprintStart,
  isActiveStatus,
  isTerminalStatus,
  mapStartGoal,
  mapWaitGoal,
  titleFromGoal,
  type ExecutionSupervisionView,
  type GoalStartResult,
  type GoalWaitResult,
} from './goal.js';
import { extractCommand, extractFilePath, foldGoalFacts, parseArgsJson, successfulKinds, type ActionKind } from './goal-facts.js';
import { reconcileTodos } from './goal-reconcile.js';
import {
  buildGoalGraph,
  describeBlocked,
  detectDeferredKinds,
  inferBlockedKind,
  resolveStepRefs,
  type BlockedInfo,
} from './goal-graph.js';
import { PollCursorMap, computeProgressDelta, nextPollCursor } from './goal-delta.js';
import { cleanupTempResources, discoverTempResources } from './temp-resources.js';
import {
  GoalControlStore,
  appendGoalEvent,
  applyNativeGetGoalResult,
  applyRevision,
  createGoalRecord,
  fileStoreIo,
  goalControlDir,
  sliceHistory,
  supervisionGoal,
  type GoalHistoryEvent,
  type GoalRecord,
  type GoalSupervisionView,
} from './goal-control.js';
import {
  evaluateConstraint,
  findConstraintViolation,
  parseConstraints,
  parseExecutionMode,
  type ExecutionMode,
  type GoalConstraints,
} from './goal-constraints.js';
import {
  asApiProxy,
  cancelQuestion,
  compositionHasWebGateway,
  respondApproval,
  respondQuestion,
  startMuxMirror,
  type ApiProxyLike,
} from './web-gateway.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';

export { normalizePath } from './paths.js';

/** Typed bridge error with a stable machine-readable code. */
export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  /** Set when the Web api-proxy parked this ask; settle via respond(). */
  muxRpcId?: string;
}

/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
  id: string;
  sessionId?: string;
  questions: AskUserQuestionItem[];
  resolve: (answer: AskUserQuestionAnswer) => void;
  muxRpcId?: string;
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
  bridge: { name: string; version: string };
  dsh: { version: string };
  runtime: { pid: number; uptimeMs: number };
  sessions: { live: number; persisted: number; active: number };
  capabilities: {
    transports: string[];
    authMode: 'token' | 'none';
    workspaceRegistry: boolean;
    sessionPersistence: boolean;
    agentPresets: boolean;
    userQuestions: boolean;
    approvals: boolean;
    workspaces: number;
    webSurface: boolean;
    goalSupervision: boolean;
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
  agent?: { status: 'idle' | 'running'; inbox: { nextTurn: number; nextStep: number } };
  pending: { nextTurn: number; nextStep: number };
  waiting: WaitingState;
  messages: MessageRow[];
  last_turn?: { turn: number; reason?: string };
  todos?: { content: string; status: string }[];
  blocked?: BlockedInfo;
  deferred_steps?: string[];
  blocked_steps?: string[];
  remaining_runnable_steps?: string[];
  goal?: GoalSupervisionView;
  execution?: ExecutionSupervisionView;
  history?: GoalHistoryEvent[];
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
  error?: { code: string; message: string };
}

/** One loaded session view: the live agent when attached, else persisted events. */
interface LoadedView {
  agent?: Agent;
  session?: Session;
  events: readonly SessionEvent[];
  header: SessionHeader;
}

const require = createRequire(import.meta.url);

/** DSH version string, resolved lazily from the installed package. */
export function dshVersion(): string {
  try {
    return (require('@deepseek-ai/dsh/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The bridge service. One instance per plugin activation. */
export class Bridge {
  private readonly ctx: Context;
  private readonly cfg: ResolvedBridgeConfig;
  private readonly log: BridgeLogger;
  /** Sessions created through this bridge (approval answering scope). */
  private readonly managed = new Set<string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private questionSeq = 0;
  private approvalsEnabled = false;
  private questionsEnabled = false;
  private started = false;
  private readonly goalRequests = new RequestIdMap();
  private readonly goalStore: GoalControlStore;
  private readonly pollCursors = new PollCursorMap();
  private apiProxy: ApiProxyLike | undefined;
  private muxAbort: AbortController | undefined;
  private webOwnsApprovals = false;
  /** Test hooks for bounded wait loops. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
    const home = typeof cfg.dshHome === 'string' && cfg.dshHome !== '' ? cfg.dshHome : undefined;
    this.goalStore = new GoalControlStore(
      home === undefined ? undefined : fileStoreIo(goalControlDir(home)),
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Register the approval answerer and the user-questions provider. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.apiProxy = asApiProxy(this.ctx.get('apiProxy'));
    // api-proxy starts later than this plugin (more inject deps). If the
    // loader already lists it, do not steal the userQuestions slot.
    const webGatewayPending = this.apiProxy === undefined && compositionHasWebGateway(this.ctx);

    if (this.apiProxy !== undefined || webGatewayPending) {
      // Same process as DSH Web: observe mux, settle through respond(). Do not
      // steal the single userQuestions slot or the approval waterfall.
      this.webOwnsApprovals = true;
      this.approvalsEnabled = true;
      this.questionsEnabled = true;
      const attachMux = (api: ApiProxyLike): void => {
        this.apiProxy = api;
        this.muxAbort?.abort();
        this.muxAbort = new AbortController();
        startMuxMirror(
          api,
          {
            onApprovalRequested: (pending) => {
              this.approvals.set(pending.approvalId, {
                id: pending.approvalId,
                sessionId: pending.sessionId,
                toolName: pending.toolName,
                callId: pending.callId,
                reason: pending.reason,
                muxRpcId: pending.rpcId,
                resolve: () => {},
              });
              this.log.info(`approval ${pending.approvalId} mirrored from Web mux for session ${pending.sessionId}`);
            },
            onApprovalResolved: (_sessionId, approvalId) => {
              this.approvals.delete(approvalId);
            },
            onQuestionRequested: (pending) => {
              this.questions.set(pending.rpcId, {
                id: pending.rpcId,
                sessionId: pending.sessionId,
                questions: pending.questions as AskUserQuestionItem[],
                muxRpcId: pending.rpcId,
                resolve: () => {},
              });
              this.log.info(`question ${pending.rpcId} mirrored from Web mux for session ${pending.sessionId}`);
            },
            onQuestionResolved: (_sessionId, questionRpcId) => {
              this.questions.delete(questionRpcId);
            },
          },
          this.muxAbort.signal,
          (message) => this.log.warn(`apiProxy mux mirror ended: ${redactText(message)}`),
        );
      };
      if (this.apiProxy !== undefined) {
        attachMux(this.apiProxy);
      } else {
        this.ctx.inject(['apiProxy'], () => {
          const api = asApiProxy(this.ctx.get('apiProxy'));
          if (api !== undefined) attachMux(api);
        });
      }
    } else {
      // Headless: this process owns the answerer seams.
      this.webOwnsApprovals = false;
      this.approvalsEnabled = true;

      const userQuestions = this.ctx.get('userQuestions');
      if (userQuestions !== undefined) {
        try {
          userQuestions.registerProvider({
            ask: async (request) => {
              const id = `question-${++this.questionSeq}`;
              const sessionId = request.agent?.id;
              return new Promise<AskUserQuestionAnswer>((resolve) => {
                this.questions.set(id, { id, sessionId, questions: request.questions, resolve });
                this.log.info(`question ${id} pending for session ${sessionId ?? '(no agent)'}`);
              });
            },
          });
          this.questionsEnabled = true;
        } catch (error) {
          this.log.warn(`userQuestions provider slot already taken by another plugin; questions will flow through it: ${redactText(String(error))}`);
          this.questionsEnabled = false;
        }
      }
    }

    this.ctx.on('approval/request', (request, next) => {
      if (!this.managed.has(request.agent.id)) return next();
      if (this.rejectConstraint(request)) return Promise.resolve('rejected' as ApprovalOutcome);
      if (this.webOwnsApprovals) return next();
      const id = `approval-${randomUUID()}`;
      const pending: PendingApproval = {
        id,
        sessionId: request.agent.id,
        toolName: request.toolName,
        callId: request.callId,
        reason: request.reason,
        resolve: () => {},
      };
      const decision = new Promise<ApprovalOutcome>((resolve) => {
        pending.resolve = resolve;
      });
      this.approvals.set(id, pending);
      this.noteGoalEvent(request.agent.id, 'approval_requested', {
        metadata: { tool: request.toolName, approval_id: id },
      });
      this.log.info(`approval ${id} pending for session ${request.agent.id} (tool ${request.toolName})`);
      request.signal?.addEventListener(
        'abort',
        () => {
          if (this.approvals.delete(id)) {
            this.log.info(`approval ${id} withdrawn (turn aborted)`);
            pending.resolve('cancelled');
          }
        },
        { once: true },
      );
      return decision;
    });

    this.ctx.effect(() => () => {
      this.muxAbort?.abort();
      for (const pending of [...this.approvals.values()]) {
        this.approvals.delete(pending.id);
        pending.resolve('cancelled');
      }
      for (const pending of [...this.questions.values()]) {
        this.questions.delete(pending.id);
        pending.resolve({ answers: [] });
      }
    });
  }

  private adopt(sessionId: string): void {
    this.managed.add(sessionId);
  }

  /** Count of bridge-created sessions still live. */
  managedCount(): number {
    return this.managed.size;
  }

  // ── model selection + composition (mirrors the web api-proxy) ─────────────

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.get('agentDefaultModel');
    if (defaults !== undefined) {
      const selection = defaults.currentSelection();
      return { provider: selection.provider, model: selection.model };
    }
    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  }

  /** Agent-scoped model selection with log-derived fallback for resumes. */
  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent;
    if (agent === undefined) throw new BridgeError('AGENT_SETUP_NO_SCOPE', 'agent setup has no scoped agent');
    const defaults = this.ctx.get('agentDefaultModel');
    let picked: ModelSelection | undefined;
    const selection: { current: ModelSelection; assembled: ModelSelection | undefined } = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader()?.config;
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
          };
        }
        if (defaults !== undefined) return defaults.currentSelection();
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
      },
      set current(next) {
        picked = next;
      },
      assembled: undefined,
    };
    installModelSelection(agentCtx, selection);
  }

  /** Compose the preset+selection setup used at agent creation/resume. */
  private async composeSetupFor(presetId: string | undefined): Promise<{
    agentPreset?: string;
    setup: (agentCtx: Context) => Promise<void> | void;
  }> {
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined) {
      return {
        setup: (agentCtx) => {
          this.installSelection(agentCtx);
        },
      };
    }
    const resolvedId = presetId ?? (await presets.resolve(undefined)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        this.installSelection(agentCtx);
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  // ── session loading ───────────────────────────────────────────────────────

  private async loadView(sessionId: string): Promise<LoadedView> {
    const liveAgent = this.ctx.agents.get(SessionId(sessionId));
    if (liveAgent !== undefined) {
      return { agent: liveAgent, session: liveAgent.session, events: liveAgent.session.events, header: liveAgent.session.header };
    }
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    try {
      const inspected = await persistence.inspect(SessionId(sessionId));
      return { events: inspected.events, header: inspected.meta };
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
  }

  /** Resolve a live agent, resuming the persisted session when needed. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) return live;
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    let inspected;
    try {
      inspected = await persistence.inspect(SessionId(sessionId));
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
    // persistence.inspect returns { meta, events }; the preset resolver
    // expects the session-shaped { header, events }.
    const presetId = resolveSessionPreset({ header: inspected.meta, events: inspected.events });
    const composition = await this.composeSetupFor(presetId);
    const { agent } = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    });
    return agent;
  }

  // ── workspace boundary ────────────────────────────────────────────────────

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    return registry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionCount: workspace.sessionIds.length,
    }));
  }

  /**
   * Resolve a workspace reference (id, canonical path, or title) against the
   * REGISTERED workspace set only. Never auto-registers and never opens an
   * arbitrary path: an unregistered path is rejected.
   */
  async resolveWorkspace(input: string): Promise<Workspace> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    const all = registry.list();
    const byId = all.find((workspace) => workspace.id === input);
    if (byId !== undefined) return byId;
    const byPath = all.find((workspace) => pathsEqual(workspace.path, input));
    if (byPath !== undefined) return byPath;
    const byTitle = all.find((workspace) => workspace.title === input);
    if (byTitle !== undefined) return byTitle;
    throw new BridgeError(
      'WORKSPACE_NOT_FOUND',
      `no registered workspace matches "${input}"; sessions can only be created in workspaces DSH already registered (dsh_list_workspaces)`,
    );
  }

  // ── operations ────────────────────────────────────────────────────────────

  async health(): Promise<HealthReport> {
    const agents = this.ctx.agents.list();
    let persisted = 0;
    try {
      persisted = (await this.ctx.get('sessionPersistence')?.list())?.length ?? 0;
    } catch {
      persisted = -1;
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? [];
    return {
      status: 'ok',
      bridge: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      dsh: { version: dshVersion() },
      runtime: { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
      sessions: {
        live: agents.length,
        persisted: Math.max(persisted, 0),
        active: agents.filter((agent) => agent.status === 'running').length,
      },
      capabilities: {
        transports: this.cfg.transport === 'stdio' ? ['stdio'] : ['streamable-http'],
        authMode: this.cfg.authMode,
        workspaceRegistry: this.ctx.get('workspaceRegistry') !== undefined,
        sessionPersistence: this.ctx.get('sessionPersistence') !== undefined,
        agentPresets: this.ctx.get('agentPresets') !== undefined,
        userQuestions: this.questionsEnabled,
        approvals: this.approvalsEnabled,
        workspaces: workspaces.length,
        webSurface: this.apiProxy !== undefined || this.ctx.get('webRuntime') !== undefined,
        goalSupervision: true,
      },
    };
  }

  async createSession(
    workspaceInput: string,
    title?: string,
    initialMessage?: string,
  ): Promise<SessionView> {
    const workspace = await this.resolveWorkspace(workspaceInput);
    const sessionId = `session-${randomUUID()}`;
    const composition = await this.composeSetupFor(undefined);
    let agent: Agent;
    try {
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: this.agentOptions(),
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        setup: composition.setup,
      });
      agent = handle.agent;
    } catch (error) {
      throw new BridgeError(
        'SESSION_CREATE_FAILED',
        `failed to create DSH session in workspace "${workspace.title}": ${redactText(error instanceof Error ? error.message : String(error))}`,
      );
    }
    this.adopt(sessionId);
    try {
      await workspace.attachSession(SessionId(sessionId));
    } catch (error) {
      this.log.warn(`session ${sessionId} could not attach to workspace ${workspace.id}: ${redactText(String(error))}`);
    }
    if (title !== undefined && title !== '') {
      try {
        this.ctx.sessionTitle?.rename(agent.session, title);
      } catch (error) {
        this.log.warn(`session ${sessionId} title rejected: ${redactText(String(error))}`);
      }
    }
    if (initialMessage !== undefined && initialMessage.trim() !== '') {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: initialMessage }],
          source: { kind: 'user' },
        }),
      );
    }
    return this.viewOf(agent);
  }

  async sendMessage(sessionId: string, message: string): Promise<{ session_id: string; accepted: boolean }> {
    if (message.trim() === '') throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
    this.adopt(sessionId);
    const agent = await this.ensureAgent(sessionId);
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }),
    );
    return { session_id: sessionId, accepted: true };
  }

  async cancelTask(sessionId: string): Promise<{ session_id: string; cancelled: boolean }> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) {
      throw new BridgeError('SESSION_NOT_LIVE', `session ${sessionId} is not loaded; only live sessions can be cancelled`);
    }
    agent.cancel({ kind: 'user' });
    return { session_id: sessionId, cancelled: true };
  }

  private waitingFor(sessionId: string, events?: readonly SessionEvent[]): WaitingState {
    const seenApprovals = new Set<string>();
    const approvals: ApprovalSummary[] = [];
    for (const pending of this.approvals.values()) {
      if (pending.sessionId !== sessionId) continue;
      seenApprovals.add(pending.id);
      approvals.push({
        approval_id: pending.id,
        session_id: pending.sessionId,
        tool_name: pending.toolName,
        ...(pending.callId === undefined ? {} : { call_id: pending.callId }),
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      });
    }
    if (events !== undefined) {
      for (const item of undecidedApprovals(events)) {
        if (seenApprovals.has(item.id)) continue;
        approvals.push({
          approval_id: item.id,
          session_id: sessionId,
          tool_name: item.toolName,
          ...(item.callId === undefined ? {} : { call_id: item.callId }),
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        });
      }
    }
    const seenQuestions = new Set<string>();
    const questions: QuestionSummary[] = [];
    for (const pending of this.questions.values()) {
      if (pending.sessionId !== sessionId) continue;
      seenQuestions.add(pending.id);
      questions.push({
        question_id: pending.id,
        ...(pending.sessionId === undefined ? {} : { session_id: pending.sessionId }),
        questions: pending.questions,
      });
    }
    if (events !== undefined) {
      for (const item of openAskUserQuestions(events)) {
        if (seenQuestions.has(item.callId)) continue;
        let parsed: { questions?: AskUserQuestionItem[] } | undefined;
        try {
          parsed = JSON.parse(item.arguments) as { questions?: AskUserQuestionItem[] };
        } catch {
          parsed = undefined;
        }
        questions.push({
          question_id: item.callId,
          session_id: sessionId,
          questions: parsed?.questions ?? [],
        });
      }
    }
    return { approvals, questions };
  }

  private async statusOf(sessionId: string, view: LoadedView): Promise<BridgeStatus> {
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const waiting = this.waitingFor(sessionId, view.events);
    return deriveStatus({
      live: view.agent !== undefined,
      agentStatus: view.agent?.status,
      hasPendingInbox: pending.nextTurn + pending.nextStep > 0,
      pendingApprovals: waiting.approvals.length,
      pendingQuestions: waiting.questions.length,
      events: view.events,
    });
  }

  private async titleOf(view: LoadedView): Promise<string | undefined> {
    if (view.session !== undefined) {
      try {
        return this.ctx.sessionTitle?.get(view.session)?.title;
      } catch {
        return undefined;
      }
    }
    try {
      return foldSessionTitle(view.events)?.title;
    } catch {
      return undefined;
    }
  }

  private async viewOf(agent: Agent): Promise<SessionView> {
    return this.getSession(agent.id, this.cfg.sessionMaxItems, this.cfg.sessionMaxChars);
  }

  async getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView> {
    const view = await this.loadView(sessionId);
    const items = maxItems ?? this.cfg.sessionMaxItems;
    const chars = maxChars ?? this.cfg.sessionMaxChars;
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const waiting = this.waitingFor(sessionId, view.events);
    const status = await this.statusOf(sessionId, view);
    const title = await this.titleOf(view);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      ...(title === undefined ? {} : { title }),
      ...(view.header.cwd === undefined ? {} : { workspace: view.header.cwd }),
      status,
      created_at: iso(view.header.createdAt),
      updated_at: view.agent !== undefined ? lastEventTime(view.events) : undefined,
      ...(view.agent === undefined
        ? {}
        : { agent: { status: view.agent.status, inbox: { nextTurn: pending.nextTurn, nextStep: pending.nextStep } } }),
      pending,
      waiting,
      messages: summarizeMessages(view.events, items, chars),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      ...this.goalFields(sessionId, view, status),
    };
  }

  async listSessions(options: { limit?: number; offset?: number; workspace?: string }): Promise<SessionSummary[]> {
    const persistence = this.ctx.get('sessionPersistence');
    const persisted = persistence === undefined ? [] : await persistence.list();
    const live = this.ctx.sessions.list();
    const byId = new Map<string, SessionHeader>();
    for (const header of persisted) byId.set(header.id, header);
    for (const session of live) byId.set(session.id, session.header);
    let rows = [...byId.values()];
    if (options.workspace !== undefined && options.workspace !== '') {
      const workspace = await this.resolveWorkspace(options.workspace);
      rows = rows.filter((header) => header.cwd !== undefined && pathsEqual(header.cwd, workspace.path));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const page = rows.slice(offset, offset + limit);
    const out: SessionSummary[] = [];
    for (const header of page) {
      const agent = this.ctx.agents.get(header.id);
      let title: string | undefined;
      if (agent !== undefined) {
        title = this.ctx.sessionTitle?.get(agent.session)?.title;
      } else {
        title = await this.cachedTitle(header);
      }
      const status = agent === undefined
        ? undefined
        : deriveStatus({
            live: true,
            agentStatus: agent.status,
            hasPendingInbox: agent.inbox.hasPending,
            pendingApprovals: this.waitingFor(header.id, agent.session.events).approvals.length,
            pendingQuestions: this.waitingFor(header.id, agent.session.events).questions.length,
            events: agent.session.events,
          });
      out.push({
        session_id: header.id,
        ...(title === undefined ? {} : { title }),
        ...(header.cwd === undefined ? {} : { workspace: header.cwd }),
        ...(status === undefined ? {} : { status }),
        created_at: iso(header.createdAt),
        ...(agent === undefined ? {} : { updated_at: lastEventTime(agent.session.events) }),
      });
    }
    return out;
  }

  /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
  private async cachedTitle(header: SessionHeader): Promise<string | undefined> {
    const cache = this.ctx.get('sessionProjectionCache');
    if (cache === undefined) return undefined;
    try {
      const snapshot = cache.cachedSnapshot(header);
      const value = snapshot?.values?.title;
      if (typeof value === 'string' && value !== '') return value;
      if (value !== null && typeof value === 'object' && 'title' in (value as Record<string, unknown>)) {
        return (value as { title?: string }).title;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async getResult(sessionId: string, maxChars?: number): Promise<ResultView> {
    const view = await this.loadView(sessionId);
    const span = lastTurnSpan(view.events);
    if (span === undefined) {
      throw new BridgeError('NO_RESULT_YET', `session ${sessionId} has no turn yet; send a message first`);
    }
    const chars = maxChars ?? this.cfg.resultMaxChars;
    const items = this.cfg.resultMaxItems;
    const text = assistantTextForTurn(view.events, span.turn);
    const status = await this.statusOf(sessionId, view);
    const error = span.reason !== undefined && span.reason.kind === 'error'
      ? { code: span.reason.error.code, message: span.reason.error.message }
      : undefined;
    return {
      session_id: sessionId,
      status,
      turn: span.turn,
      summary: truncate(text, chars),
      assistant_text: truncate(text, chars),
      changed_files: changedFilesForTurn(view.events, span.turn),
      tool_calls: toolCallsForTurn(view.events, span.turn, items).map((call) => ({
        ...call,
        arguments: truncate(call.arguments, 500),
      })),
      ...(error === undefined ? {} : { error }),
    };
  }

  async getTaskStatus(sessionId: string): Promise<{
    session_id: string;
    status: BridgeStatus;
    live: boolean;
    agent_status?: 'idle' | 'running';
    pending: { nextTurn: number; nextStep: number };
    waiting: WaitingState;
    last_turn?: { turn: number; reason?: string };
    updated_at?: string;
    todos?: { content: string; status: string }[];
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
  }> {
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      status,
      live: view.agent !== undefined,
      ...(view.agent === undefined ? {} : { agent_status: view.agent.status }),
      pending,
      waiting: this.waitingFor(sessionId, view.events),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      updated_at: lastEventTime(view.events),
      ...this.goalFields(sessionId, view, status),
    };
  }

  // ── Goal Supervision ──────────────────────────────────────────────────────

  async startGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    request_id?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
  }): Promise<GoalStartResult> {
    if (input.goal.trim() === '') throw new BridgeError('EMPTY_GOAL', 'goal must not be empty');
    const fingerprint = fingerprintStart(input);
    if (input.request_id !== undefined && input.request_id !== '') {
      const existing = this.goalRequests.get(input.request_id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new BridgeError(
            'REQUEST_ID_CONFLICT',
            `request_id "${input.request_id}" was already used with different start_goal arguments`,
          );
        }
        this.adopt(existing.sessionId);
        const view = await this.loadView(existing.sessionId);
        return this.mapGoalStart(existing.sessionId, view);
      }
    }
    let sessionId = input.session_id;
    if (sessionId === undefined || sessionId === '') {
      const created = await this.createSession(input.workspace, titleFromGoal(input.goal));
      sessionId = created.session_id;
    } else {
      await this.resolveWorkspace(input.workspace);
      this.adopt(sessionId);
    }
    const record = this.applyStartOrRevise(sessionId, input);
    await this.sendMessage(sessionId, this.controlMessage(record, input.goal, input.plan, record.revision === 1 ? 'start' : 'revise'));
    if (input.request_id !== undefined && input.request_id !== '') {
      this.goalRequests.set(input.request_id, { sessionId, fingerprint });
    }
    const view = await this.loadView(sessionId);
    return this.mapGoalStart(sessionId, view);
  }

  async updateGoal(input: {
    session_id: string;
    action?: 'revise' | 'defer' | 'resume';
    goal?: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    defer_steps?: string[];
    resume_steps?: string[];
    revision_reason?: string;
    request_id?: string;
    workspace?: string;
  }): Promise<GoalStartResult> {
    const sessionId = input.session_id;
    if (sessionId.trim() === '') throw new BridgeError('SESSION_REQUIRED', 'dsh_update_goal requires session_id');
    const action = input.action ?? 'revise';
    const fingerprint = fingerprintStart({
      workspace: input.workspace ?? '',
      goal: input.goal ?? '',
      plan: input.plan,
      session_id: sessionId,
      execution_mode: input.execution_mode,
      constraints: input.constraints,
      action,
    });
    if (input.request_id !== undefined && input.request_id !== '') {
      const existing = this.goalRequests.get(input.request_id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new BridgeError(
            'REQUEST_ID_CONFLICT',
            `request_id "${input.request_id}" was already used with different update_goal arguments`,
          );
        }
        this.adopt(existing.sessionId);
        const view = await this.loadView(existing.sessionId);
        return this.mapGoalStart(existing.sessionId, view);
      }
    }
    this.adopt(sessionId);
    await this.ensureAgent(sessionId);
    const current = this.goalStore.get(sessionId);
    if (action === 'resume' && current === undefined) {
      throw new BridgeError('GOAL_NOT_FOUND', `no supervised goal on session ${sessionId}; resume will not create one`);
    }
    const viewBefore = await this.loadView(sessionId);
    const observed = this.observeGoal(sessionId, viewBefore, await this.statusOf(sessionId, viewBefore));
    const resolvedDefer = input.defer_steps === undefined
      ? { ids: [] as string[], kinds: [] as ActionKind[] }
      : resolveStepRefs(input.defer_steps, observed.graph.steps);
    const resolvedResume = input.resume_steps === undefined
      ? { ids: action === 'resume' ? [...(current?.deferred_step_ids ?? [])] : [], kinds: [] as ActionKind[] }
      : resolveStepRefs(input.resume_steps, observed.graph.steps);
    const detected = detectDeferredKinds(input.goal ?? current?.goal ?? '', input.plan ?? current?.plan);
    const deferIds = uniqueStrings([
      ...resolvedDefer.ids,
      ...resolvedDefer.kinds,
      ...detected,
      ...(action === 'defer' ? (input.defer_steps ?? []) : []),
    ]);
    const resumeIds = uniqueStrings([...resolvedResume.ids, ...resolvedResume.kinds]);
    let record = current ?? createGoalRecord({
      sessionId,
      goal: input.goal ?? 'continued goal',
      plan: input.plan,
      mode: parseExecutionMode(input.execution_mode),
      constraints: parseConstraints(input.constraints),
      now: this.now(),
    });
    if (current === undefined) this.goalStore.put(record);
    record = applyRevision(record, {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      ...(input.execution_mode === undefined ? {} : { mode: parseExecutionMode(input.execution_mode) }),
      ...(input.constraints === undefined ? {} : { constraints: parseConstraints(input.constraints) }),
      ...(deferIds.length === 0 ? {} : { deferredStepIds: deferIds }),
      ...(action === 'resume' ? { resumeStepIds: resumeIds } : {}),
      completedActionKinds: [...successfulKinds(observed.facts)],
      revisionReason: input.revision_reason ?? (
        action === 'resume' ? 'user_resumed_goal' : action === 'defer' ? 'user_deferred_step' : 'user_modified_goal'
      ),
      now: this.now(),
    }, action === 'resume' ? 'goal_resumed' : 'goal_revised');
    this.goalStore.put(record);
    const intent = action === 'resume' ? 'resume' : action === 'defer' ? 'defer' : 'revise';
    await this.sendMessage(sessionId, this.controlMessage(
      record,
      input.goal ?? record.goal,
      input.plan ?? record.plan,
      intent,
      resumeIds,
    ));
    if (input.request_id !== undefined && input.request_id !== '') {
      this.goalRequests.set(input.request_id, { sessionId, fingerprint });
    }
    const view = await this.loadView(sessionId);
    return this.mapGoalStart(sessionId, view);
  }

  async waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult> {
    this.adopt(sessionId);
    const seconds = clampWaitSeconds(waitSeconds);
    const started = this.now();
    const deadline = started + seconds * 1000;
    let view = await this.loadView(sessionId);
    let status = await this.statusOf(sessionId, view);
    while (isActiveStatus(status) && this.now() < deadline) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(WAIT_POLL_MS, remaining));
      view = await this.loadView(sessionId);
      status = await this.statusOf(sessionId, view);
    }
    return this.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
  }

  async stopGoal(sessionId: string): Promise<{
    session_id: string;
    stopped: true;
    already_stopped: boolean;
    status: BridgeStatus;
    cleanup_warning?: string;
  }> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    if (isTerminalStatus(status) || status === 'unknown' || (status === 'idle' && view.agent === undefined)) {
      const warning = this.cleanupGoalTemps(sessionId, view);
      return {
        session_id: sessionId,
        stopped: true,
        already_stopped: true,
        status,
        ...(warning === undefined ? {} : { cleanup_warning: warning }),
      };
    }
    if (status === 'idle' && view.agent !== undefined && !isActiveStatus(status)) {
      const warning = this.cleanupGoalTemps(sessionId, view);
      return {
        session_id: sessionId,
        stopped: true,
        already_stopped: true,
        status,
        ...(warning === undefined ? {} : { cleanup_warning: warning }),
      };
    }
    await this.failClosedWaiting(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined) agent.cancel({ kind: 'user' });
    const warning = this.cleanupGoalTemps(sessionId, view);
    this.noteGoalEvent(sessionId, 'goal_cancelled');
    return {
      session_id: sessionId,
      stopped: true,
      already_stopped: false,
      status: 'cancelled',
      ...(warning === undefined ? {} : { cleanup_warning: warning }),
    };
  }

  private async failClosedWaiting(sessionId: string): Promise<void> {
    for (const pending of [...this.approvals.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(pending.id);
      if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
        await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, pending.id, 'rejected');
      } else {
        pending.resolve('cancelled');
      }
    }
    for (const pending of [...this.questions.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.questions.delete(pending.id);
      if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
        await cancelQuestion(this.apiProxy, pending.muxRpcId);
      } else {
        pending.resolve({ answers: [] });
      }
    }
  }

  private applyStartOrRevise(sessionId: string, input: {
    goal: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
  }): GoalRecord {
    const existing = this.goalStore.get(sessionId);
    const mode = parseExecutionMode(input.execution_mode);
    const constraints = parseConstraints(input.constraints);
    const detected = detectDeferredKinds(input.goal, input.plan);
    if (existing === undefined) {
      const created = createGoalRecord({
        sessionId,
        goal: input.goal,
        plan: input.plan,
        mode,
        constraints,
        now: this.now(),
        revisionReason: 'goal_created',
      });
      if (detected.length > 0) created.deferred_step_ids = [...new Set(detected)];
      return this.goalStore.put(created);
    }
    return this.goalStore.put(applyRevision(existing, {
      goal: input.goal,
      plan: input.plan,
      mode,
      constraints,
      deferredStepIds: detected,
      revisionReason: 'user_modified_goal',
      now: this.now(),
    }, 'goal_revised'));
  }

  private controlMessage(
    record: GoalRecord,
    goal: string,
    plan: string | undefined,
    intent: 'start' | 'revise' | 'resume' | 'defer',
    resumeSteps?: string[],
  ): string {
    return buildSupervisedGoalContext(record, goal, plan, intent, resumeSteps);
  }

  private async mapGoalStart(sessionId: string, view: LoadedView): Promise<GoalStartResult> {
    const status = await this.statusOf(sessionId, view);
    const observed = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(this.goalStore.get(sessionId), undefined);
    const currentStep = observed.blocked?.step
      ?? observed.graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? observed.graph.remaining_runnable_steps[0];
    return mapStartGoal(sessionId, status, DEFAULT_WAIT_SECONDS, {
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(observed.graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
  }

  private noteGoalEvent(
    sessionId: string,
    type: GoalHistoryEvent['type'],
    extra?: { step_id?: string; metadata?: Record<string, unknown> },
  ): void {
    const record = this.goalStore.get(sessionId);
    if (record === undefined) return;
    this.goalStore.put(appendGoalEvent(record, type, { ...extra, now: this.now() }));
  }

  private rejectConstraint(request: {
    agent: { id: string; session?: { events: readonly { type: string; data?: unknown }[] } };
    toolName: string;
    callId?: string;
  }): boolean {
    const record = this.goalStore.get(request.agent.id);
    if (record === undefined) return false;
    const hasRules = Object.keys(record.constraints).length > 0 || record.completed_action_kinds.length > 0;
    if (!hasRules) return false;
    const command = commandForCall(request.agent.session?.events, request.callId);
    const changed = changedFileCountOf(request.agent.session?.events);
    const decision = evaluateConstraint({
      constraints: record.constraints,
      completedKinds: record.completed_action_kinds,
      changedFileCount: changed,
      toolName: request.toolName,
      command,
    });
    if (decision.allow) return false;
    this.goalStore.put(appendGoalEvent(record, 'constraint_rejected', {
      now: this.now(),
      ...(decision.kind === undefined ? {} : { step_id: decision.kind }),
      metadata: {
        reason: decision.reason,
        tool: request.toolName,
        ...(decision.action_class === undefined ? {} : { action_class: decision.action_class }),
      },
    }));
    this.log.info(`constraint rejected ${request.toolName} on ${request.agent.id}: ${decision.reason}`);
    return true;
  }

  private observeGoal(sessionId: string, view: LoadedView, status: BridgeStatus) {
    const facts = foldGoalFacts(view.events);
    let record = this.goalStore.get(sessionId);
    const succeeded = [...successfulKinds(facts)];
    if (record !== undefined && succeeded.some((kind) => !record!.completed_action_kinds.includes(kind))) {
      record = {
        ...record,
        completed_action_kinds: [...new Set([...record.completed_action_kinds, ...succeeded])],
      };
      this.goalStore.put(record);
    }
    const isHeld = status === 'waiting_for_approval' || status === 'waiting_for_user' || status === 'blocked';
    const waitingKinds = isHeld
      ? (() => {
          const kind = inferBlockedKind(facts, status);
          return kind === undefined ? [] : [kind];
        })()
      : [];
    const todos = reconcileTodos({
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      facts,
      waitingKinds,
      holdInProgress: isHeld,
    });
    const blockedKind = inferBlockedKind(facts, status);
    const deferredKinds = deferredKindsOf(record);
    const graph = buildGoalGraph({
      ...(todos === undefined ? {} : { todos }),
      ...(record?.plan === undefined ? {} : { plan: record.plan }),
      facts,
      deferredKinds,
      ...(record === undefined ? {} : { deferredStepIds: record.deferred_step_ids }),
      ...(blockedKind === undefined ? {} : { blockedKind }),
      ...(status === 'waiting_for_user' || status === 'waiting_for_approval' ? { waitingStatus: status } : {}),
    });
    const waiting = this.waitingFor(sessionId, view.events);
    let blocked = describeBlocked({
      status,
      facts,
      graph,
      approval: waiting.approvals[0],
      question: waiting.questions[0],
    });
    if (record !== undefined) {
      const violation = findPostHocViolation(facts, record);
      if (violation !== undefined) {
        blocked = {
          step: violation.step,
          reason: 'constraint_rejected',
          resume_condition: `Constraint ${violation.reason} rejected this action. Revise constraints or the goal, then resume.`,
          scope: graph.remaining_runnable_steps.length > 0 ? 'step' : 'goal',
          independent_steps_available: graph.remaining_runnable_steps.length > 0,
        };
      }
    }
    return { facts, todos, graph, blocked, waiting, record };
  }

  private goalFields(sessionId: string, view: LoadedView, status: BridgeStatus): {
    todos?: { content: string; status: string }[];
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
  } {
    const { todos, graph, blocked, record: observedRecord } = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? graph.remaining_runnable_steps[0];
    return {
      ...(todos === undefined ? {} : { todos }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(graph.deferred_steps.length === 0 ? {} : { deferred_steps: graph.deferred_steps }),
      ...(graph.blocked_steps.length === 0 ? {} : { blocked_steps: graph.blocked_steps }),
      ...(graph.remaining_runnable_steps.length === 0 ? {} : { remaining_runnable_steps: graph.remaining_runnable_steps }),
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    };
  }

  private cleanupGoalTemps(sessionId: string, view: LoadedView): string | undefined {
    const workspace = view.header.cwd;
    if (typeof workspace !== 'string' || workspace === '') return undefined;
    const facts = foldGoalFacts(view.events);
    const record = this.goalStore.get(sessionId);
    const resources = discoverTempResources({
      facts,
      sessionId,
      goalId: record?.goal_id ?? sessionId,
      workspacePath: workspace,
    });
    if (resources.length === 0) return undefined;
    const cleaned = cleanupTempResources(resources, workspace);
    if (cleaned.warnings.length === 0) return undefined;
    return cleaned.warnings.join('; ');
  }

  private async goalSnapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
  ): Promise<GoalWaitResult> {
    const { facts, todos, graph, blocked, waiting, record: observedRecord } = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const span = lastTurnSpan(view.events);
    const changedFiles = span === undefined ? [] : changedFilesForTurn(view.events, span.turn);
    const errorSummary = span?.reason !== undefined && span.reason.kind === 'error'
      ? `${span.reason.error.code}: ${span.reason.error.message}`
      : undefined;
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress')?.content
      ?? graph.remaining_runnable_steps[0];
    const approvalIds = waiting.approvals.map((item) => item.approval_id);
    const questionIds = waiting.questions.map((item) => item.question_id);
    const deltaInput = {
      events: view.events,
      facts,
      ...(todos === undefined ? {} : { todos }),
      status,
      changedFiles,
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approvalIds,
      questionIds,
      previous: this.pollCursors.get(sessionId),
      ...(currentStep === undefined ? {} : { currentStep }),
    };
    const progressDelta = computeProgressDelta(deltaInput);
    this.pollCursors.set(sessionId, nextPollCursor(deltaInput));
    const mapped = mapWaitGoal({
      sessionId,
      status,
      waitedMs,
      waitSeconds,
      ...(todos === undefined ? {} : { todos }),
      lastActivity: lastEventTime(view.events),
      ...(span === undefined ? {} : { lastTurn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      changedFiles,
      assistantSummary: span === undefined ? '' : assistantTextForTurn(view.events, span.turn),
      ...(errorSummary === undefined ? {} : { errorSummary }),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approval: waiting.approvals[0],
      question: waiting.questions[0],
      progressDelta,
      ...(blocked === undefined ? {} : { blocked }),
      deferredSteps: graph.deferred_steps,
      blockedSteps: graph.blocked_steps,
      remainingRunnableSteps: graph.remaining_runnable_steps,
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
    if (mapped.terminal && record !== undefined && (status === 'completed' || status === 'cancelled' || status === 'failed')) {
      const already = record.history.some((event) => event.type === 'goal_completed' || event.type === 'goal_cancelled');
      if (!already) {
        this.goalStore.put(appendGoalEvent(record, status === 'cancelled' ? 'goal_cancelled' : 'goal_completed', { now: this.now() }));
      }
    }
    if (!mapped.terminal) return mapped;
    const warning = this.cleanupGoalTemps(sessionId, view);
    return warning === undefined ? mapped : { ...mapped, cleanup_warning: warning };
  }

  // ── user questions / approvals ────────────────────────────────────────────

  async answerQuestion(questionId: string, sessionId: string | undefined, answer: {
    selected: string[];
    custom?: string;
  }): Promise<{ answered: true }> {
    const pending = [...this.questions.values()].find(
      (item) => item.id === questionId && (sessionId === undefined || item.sessionId === sessionId),
    );
    if (pending === undefined) {
      throw new BridgeError('QUESTION_NOT_FOUND', `no pending question ${questionId}`);
    }
    const question = pending.questions[0];
    const labels = new Set(question?.options?.map((option) => option.label) ?? []);
    if (answer.selected.some((label) => !labels.has(label))) {
      throw new BridgeError('INVALID_ANSWER', `selected option(s) are not offered by question ${questionId}`);
    }
    if (question?.multiSelect !== true && answer.selected.length > 1) {
      throw new BridgeError('INVALID_ANSWER', `question ${questionId} is single-select`);
    }
    this.questions.delete(questionId);
    const resolved: AskUserQuestionAnswer = {
      answers: [
        {
          id: pending.questions[0]?.id ?? questionId,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        },
      ],
    };
    if (pending.muxRpcId !== undefined && this.apiProxy !== undefined && pending.sessionId !== undefined) {
      const receipt = await respondQuestion(this.apiProxy, pending.muxRpcId, pending.sessionId, resolved);
      if (!receipt.accepted) {
        throw new BridgeError('QUESTION_NOT_FOUND', `Web gateway rejected answer for ${questionId}: ${receipt.reason ?? 'not-pending'}`);
      }
    } else {
      pending.resolve(resolved);
    }
    this.log.info(`question ${questionId} answered`);
    if (pending.sessionId !== undefined) {
      this.noteGoalEvent(pending.sessionId, 'question_answered', { metadata: { question_id: questionId } });
    }
    return { answered: true };
  }

  async approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
    approval_id: string;
    session_id: string;
    decision: 'approve' | 'reject';
    outcome: ApprovalOutcome;
  }> {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) {
      throw new BridgeError('APPROVAL_NOT_FOUND', `no pending approval ${approvalId}`);
    }
    if (pending.sessionId !== sessionId) {
      throw new BridgeError('APPROVAL_SESSION_MISMATCH', `approval ${approvalId} belongs to session ${pending.sessionId}`);
    }
    this.approvals.delete(approvalId);
    const outcome: ApprovalOutcome = decision === 'approve' ? 'allowed-once' : 'rejected';
    if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
      const receipt = await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, approvalId, outcome);
      if (!receipt.accepted) {
        throw new BridgeError('APPROVAL_NOT_FOUND', `Web gateway rejected decision for ${approvalId}: ${receipt.reason ?? 'not-pending'}`);
      }
    } else {
      pending.resolve(outcome);
    }
    this.log.info(`approval ${approvalId} decided: ${decision}`);
    this.noteGoalEvent(sessionId, 'approval_resolved', { metadata: { approval_id: approvalId, decision } });
    return { approval_id: approvalId, session_id: sessionId, decision, outcome };
  }

  // ── introspection used by the MCP layer ───────────────────────────────────

  listManaged(): string[] {
    return [...this.managed];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim() !== ''))];
}

const KNOWN_KINDS = new Set<string>([
  'git_push', 'git_tag', 'npm_publish', 'github_release', 'git_worktree_add', 'npm_pack',
]);

function deferredKindsOf(record?: GoalRecord): ActionKind[] {
  if (record === undefined) return [];
  return record.deferred_step_ids.filter((id): id is ActionKind => KNOWN_KINDS.has(id));
}

function commandForCall(
  events: readonly { type: string; data?: unknown }[] | undefined,
  callId?: string,
): string | undefined {
  if (events === undefined || callId === undefined) return undefined;
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined || data.callId !== callId) continue;
    const raw = typeof data.arguments === 'string' ? data.arguments : '';
    const args = raw === '' ? undefined : parseArgsJson(raw);
    return args === undefined ? undefined : extractCommand(args);
  }
  return undefined;
}

function changedFileCountOf(events: readonly { type: string; data?: unknown }[] | undefined): number {
  if (events === undefined) return 0;
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined || typeof data.arguments !== 'string') continue;
    const args = parseArgsJson(data.arguments);
    if (args === undefined) continue;
    const path = extractFilePath(args);
    if (path !== undefined) seen.add(path);
  }
  return seen.size;
}

function findPostHocViolation(
  facts: ReturnType<typeof foldGoalFacts>,
  record: GoalRecord,
): { step: string; reason: string } | undefined {
  const found = findConstraintViolation(facts, record.constraints, []);
  if (found === undefined) return undefined;
  // Replay is enforced on later approvals, not on the original successful run
  // (a tag create + tag push in one turn is two git_tag facts, not a replay).
  if (found.decision.reason === 'no_destructive_replay') return undefined;
  return {
    step: found.fact.command ?? found.fact.name,
    reason: found.decision.reason ?? 'constraint_rejected',
  };
}