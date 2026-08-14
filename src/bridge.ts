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
  lastTodos,
  lastTurnSpan,
  summarizeMessages,
  toolCallsForTurn,
  type MessageRow,
  type ToolCallInfo,
} from './session-view.js';
import {
  RequestIdMap,
  WAIT_POLL_MS,
  buildGoalMessage,
  clampWaitSeconds,
  fingerprintStart,
  isActiveStatus,
  isTerminalStatus,
  mapStartGoal,
  mapWaitGoal,
  titleFromGoal,
  type GoalStartResult,
  type GoalWaitResult,
} from './goal.js';
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

/** Normalize a path for comparison (case-insensitive on win32). */
export function normalizePath(path: string): string {
  const normalized = path.replace(/[\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
  private apiProxy: ApiProxyLike | undefined;
  private muxAbort: AbortController | undefined;
  /** Test hooks for bounded wait loops. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
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
        (this.ctx as unknown as { inject(deps: string[], cb: () => void): void }).inject(['apiProxy'], () => {
          const api = asApiProxy(this.ctx.get('apiProxy'));
          if (api !== undefined) attachMux(api);
        });
      }
    } else {
      // Headless: this process owns the answerer seams.
      this.ctx.on('approval/request', (request, next) => {
        if (!this.managed.has(request.agent.id)) return next();
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

    (this.ctx as unknown as { on(event: string, cb: () => void): void }).on('dispose', () => {
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
    const normalized = normalizePath(input);
    const byPath = all.find((workspace) => normalizePath(workspace.path) === normalized);
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
      ...(lastTodos(view.events) === undefined ? {} : { todos: lastTodos(view.events) as { content: string; status: string }[] }),
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
      const normalized = normalizePath(workspace.path);
      rows = rows.filter((header) => header.cwd !== undefined && normalizePath(header.cwd as string) === normalized);
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
    };
  }

  // ── Goal Supervision ──────────────────────────────────────────────────────

  async startGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    request_id?: string;
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
        return mapStartGoal(existing.sessionId, await this.statusOf(existing.sessionId, view));
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
    await this.sendMessage(sessionId, buildGoalMessage(input.goal, input.plan));
    if (input.request_id !== undefined && input.request_id !== '') {
      this.goalRequests.set(input.request_id, { sessionId, fingerprint });
    }
    const view = await this.loadView(sessionId);
    return mapStartGoal(sessionId, await this.statusOf(sessionId, view));
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
  }> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    if (isTerminalStatus(status) || status === 'unknown' || (status === 'idle' && view.agent === undefined)) {
      return { session_id: sessionId, stopped: true, already_stopped: true, status };
    }
    if (status === 'idle' && view.agent !== undefined && !isActiveStatus(status)) {
      return { session_id: sessionId, stopped: true, already_stopped: true, status };
    }
    await this.failClosedWaiting(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined) agent.cancel({ kind: 'user' });
    return { session_id: sessionId, stopped: true, already_stopped: false, status: 'cancelled' };
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

  private async goalSnapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
  ): Promise<GoalWaitResult> {
    const waiting = this.waitingFor(sessionId, view.events);
    const span = lastTurnSpan(view.events);
    const todos = lastTodos(view.events);
    const errorSummary = span?.reason !== undefined && span.reason.kind === 'error'
      ? `${span.reason.error.code}: ${span.reason.error.message}`
      : undefined;
    return mapWaitGoal({
      sessionId,
      status,
      waitedMs,
      waitSeconds,
      ...(todos === undefined ? {} : { todos }),
      lastActivity: lastEventTime(view.events),
      ...(span === undefined ? {} : { lastTurn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      changedFiles: span === undefined ? [] : changedFilesForTurn(view.events, span.turn),
      assistantSummary: span === undefined ? '' : assistantTextForTurn(view.events, span.turn),
      ...(errorSummary === undefined ? {} : { errorSummary }),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approval: waiting.approvals[0],
      question: waiting.questions[0],
    });
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
    return { approval_id: approvalId, session_id: sessionId, decision, outcome };
  }

  // ── introspection used by the MCP layer ───────────────────────────────────

  listManaged(): string[] {
    return [...this.managed];
  }
}