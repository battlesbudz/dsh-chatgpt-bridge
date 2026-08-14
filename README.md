# dsh-chatgpt-bridge

An MCP bridge that lets **ChatGPT Web** create, view, continue and control
**DeepSeek Harness (DSH)** agent sessions through the official **Model Context
Protocol**. The bridge only *connects* — DSH keeps its own session log, agent
loop, tools, skills, subagents, workflows, approvals, sandbox and workspace
security model. It is a standalone DSH plugin: **zero DSH core modifications**.

> Self-hosted / dogfooding development: implemented against the installed DeepSeek
> Harness source (`0.1.0-rc.6`) and verified end-to-end against a live local DSH
> runtime with the official MCP SDK client.

---

## Architecture

```text
ChatGPT Web
      |
      | MCP (Streamable HTTP / stdio)
      v
dsh-chatgpt-bridge        <- a DSH (Cordis) plugin row
      |
      v
DeepSeek Harness          <- sessions, agents, tools, approvals, sandbox, workspace
      |
 +----+--------------+
 |    |              |
Session   Agent     Workflow
 |    |              |
 +----+------+-------+
             v
       Local Workspace
```

The bridge uses DSH's public plugin seams — it never re-implements DSH:

| DSH capability seam | Usage in the bridge |
| --- | --- |
| `ctx.agents` (AgentRegistry) | `create()` / `resume()` / `get()` — live agent lookup, session creation, and **resume of persisted sessions after restarts** |
| `ctx.sessions` (SessionStore) | live session listing, `flush()` durability |
| `ctx.sessionPersistence` | `list()` / `inspect()` — the DSH session log is the **authority** for session identity across ChatGPT conversations |
| `ctx.sessionTitle` | title read/write (plus the `session/title` log fold) |
| `ctx.workspaceRegistry` | list + resolve — **only registered workspaces** can host sessions |
| `ctx.approval` (`approval/request` waterfall) | the bridge is an **answerer**: approvals park as `waiting_for_approval` and are decided one-by-one |
| `ctx.userQuestions` (`registerProvider`) | the bridge is the question **provider**: questions park as `waiting_for_user` |
| `ctx.agentDefaultModel` | default provider/model selection for created sessions |
| `ctx.agentPresets` (`mount`) | same per-session preset composition the Web UI uses, when a roster exists |
| `installModelSelection` (dsh-agent) | per-agent model selection with log-derived fallback on resume |
| `createUserMessage` + `agent.followup()` | the canonical way to continue a session's durable log |

### MCP facts

| Item | Value |
| --- | --- |
| Transport | **Streamable HTTP** (default, `http://127.0.0.1:3456/mcp`) or **stdio** |
| Protocol version | negotiated by `@modelcontextprotocol/sdk` 1.30.0 (official MCP SDK) |
| Authentication | Bearer token (default): config token → `DSH_CHATGPT_BRIDGE_TOKEN` env → generated token persisted to `$DSH_HOME/chatgpt-bridge.token` |
| Local endpoint | `http://127.0.0.1:3456/mcp` (loopback only by default) |
| ChatGPT connection | any official MCP client: a local connector at the endpoint with the token, or a remote connector tunneled to the loopback endpoint. The bridge never exposes anything public by itself. |

---

## Install

The plugin is a standard DSH profile bundle. It currently targets DSH
`0.1.0-rc.6`.

### Install from npm (recommended)

Create a dedicated profile, install the published package from npm, then boot
that profile. These commands invoke the real DSH CLI directly and do not rely
on a shell alias or function:

```bash
# 1. create the profile and install dsh-chatgpt-bridge from npm
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile chatgpt-bridge add dsh-chatgpt-bridge@0.1.0

# 2. boot the profile
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 --profile chatgpt-bridge
```

The published npm package is available at
[`dsh-chatgpt-bridge`](https://www.npmjs.com/package/dsh-chatgpt-bridge).

### Install from source

To develop or inspect the bridge locally, clone this repository, install its
dependencies, build it, then add the checkout to a dedicated DSH profile:

```bash
# 1. clone, install and build
git clone https://github.com/jiezeng2004-design/dsh-chatgpt-bridge.git
cd dsh-chatgpt-bridge
npm ci
npm run build

# 2. create the profile and add this checkout (pnpm required; `file:` spec)
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile chatgpt-bridge add "file:$PWD"

# 3. boot it
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 --profile chatgpt-bridge
```

For either installation method, `dsh plugin` installs the package into the
profile and, because the package declares `dsh.bundle.patch`, appends it to the
profile's bundle list. The bundle patch adds the rows the bridge needs
(storage, workspace registry, projection cache) plus the `chatgpt-bridge` row
itself.

If pnpm cannot run in your environment (e.g. symlinks blocked), install
manually: create `$DSH_HOME/profiles/chatgpt-bridge/` with `package.json`
(`dsh.profile.bundles: ["@deepseek-ai/dsh-base", "dsh-chatgpt-bridge"]`),
empty `cordis.yml` / `cordis.patch.yml`, and a
`node_modules/dsh-chatgpt-bridge` link to this checkout. The checkout's own
`node_modules` may be a junction to the DSH installation's hoisted
`node_modules` so both sides share one module instance.

### DSH configuration

Only the plugin's own row config (defaults shown):

```yaml
- id: chatgpt-bridge
  name: dsh-chatgpt-bridge
  config:
    transport: http        # http | stdio
    host: 127.0.0.1        # loopback only by default
    port: 3456
    authMode: token        # token | none (loopback only, not recommended)
    authToken: ''          # static token; empty falls back to env, then generated file
    authTokenEnv: DSH_CHATGPT_BRIDGE_TOKEN
    tokenFile: ''          # default $DSH_HOME/chatgpt-bridge.token
    resultMaxChars: 8000
    resultMaxItems: 50
    sessionMaxItems: 20
    sessionMaxChars: 4000
    logLevel: info
```

Logs go to `$DSH_HOME/chatgpt-bridge.log` (redacted) and never to stdout, so
the stdio transport stays clean.

---

## ChatGPT MCP configuration

1. Start the bridge (`dsh --profile chatgpt-bridge`) and note the token:
   `Get-Content $env:USERPROFILE\.dsh\chatgpt-bridge.token` (or set
   `DSH_CHATGPT_BRIDGE_TOKEN` yourself).
2. In ChatGPT, add a **custom MCP connector**:
   - **Local:** point it at `http://127.0.0.1:3456/mcp` with the bearer token
     as the authorization header; or use a stdio connector whose command is
     `dsh --profile chatgpt-bridge` (a stdio-mode profile).
   - **Remote/tunneled:** run the bridge on the loopback and connect ChatGPT
     through the platform's supported secure MCP tunnel mechanism. The
     bridge itself never binds a public interface and never self-hosts a
     tunnel.
3. Verify with `dsh_health`.

No ChatGPT cookies, logins, or web sessions are ever touched: ChatGPT is
strictly an MCP client of the bridge.

---

## MCP tool catalog

| Tool | Purpose |
| --- | --- |
| `dsh_health` | Bridge/DSH status, versions, session counts, capabilities. Never contains tokens/keys/cookies. |
| `dsh_list_workspaces` | Workspaces DSH already registered (id, title, path, counts). |
| `dsh_create_session` | Create a real DSH session bound to a registered workspace (id/path/title). Optional `title` and `initial_message`. |
| `dsh_list_sessions` | Live + persisted sessions, newest first, paged (`limit`/`offset`), optional workspace filter. |
| `dsh_get_session` | Status, workspace, bounded recent-message summary (`max_items`/`max_chars`), pending work, waiting approvals/questions, todos. |
| `dsh_send_message` | **Continue an existing DSH session** (live agent, or resume from persistence). Returns immediately; long tasks run in the background. |
| `dsh_get_task_status` | `idle`, `queued`, `running`, `waiting_for_user`, `waiting_for_approval`, `completed`, `failed`, `cancelled`, `blocked`, `max-tokens`, `interrupted` (DSH-native turn-end reasons). |
| `dsh_get_result` | Last turn's assistant text, status, tool calls, changed files (from the session log), structured error. |
| `dsh_cancel_task` | Cancel through DSH's own `agent.cancel()` — no PID killing. |
| `dsh_answer_question` | Answer a parked user question (`waiting_for_user`). |
| `dsh_approve` | Decide one parked approval (`waiting_for_approval`) — requires the exact `approval_id` and an explicit `approve`/`reject`. No approve-all. |

### Deliberately NOT exposed (first version)

`execute_shell`, `run_command`, `read_any_file`, `write_any_file`,
`delete_file`, `git_push`, `install_package`, `run_arbitrary_tool`.
ChatGPT never gets a direct shell: it talks to the DSH agent, and the DSH
agent uses DSH tools under DSH's approval/sandbox/workspace policy.

---

## Session lifecycle

```text
ChatGPT: dsh_create_session(workspace)
         -> session_id (e.g. session-034daf61-...)
ChatGPT: dsh_send_message(session_id, "帮我分析这个项目，不修改文件。")
         -> {accepted: true}            # returns immediately
DSH:     agent.followup() -> turn runs in the background
ChatGPT: dsh_get_task_status(session_id) -> running -> completed
ChatGPT: dsh_get_result(session_id)      -> analysis text
ChatGPT: dsh_send_message(session_id, "刚才第 2 项不错，现在实现它。")
         -> same session, same agent loop, same durable log
```

**DSH is the authority for session identity.** Sessions persist as
`$DSH_HOME/sessions/<workspace>/<session-id>/session.jsonl.zstd` (event log)
and survive bridge restarts, ChatGPT conversations, and DSH restarts:
`dsh_send_message` on a cold session resumes it through `ctx.agents.resume()`,
which replays the log into the model context (verified: a marker learned
before a process restart was still remembered afterwards).

---

## Security model

- **No arbitrary shell tool** — see the tool catalog.
- **Workspace boundary** — sessions can only be created in workspaces DSH
  already registered (`ctx.workspaceRegistry`). Arbitrary paths are never
  opened or auto-registered; `dsh_create_session` with `C:\Users\...`, `/`,
  `~`, etc. is rejected with `WORKSPACE_NOT_FOUND`.
- **Approval is never bypassed** — if DSH asks for approval, the bridge parks
  the request (`waiting_for_approval`) and only `dsh_approve` with the exact
  approval id can grant it, **once, for that exact tool call**
  (`allowed-once`). No auto-approve, no approve-all. If the bridge unloads
  while requests are parked, they resolve `cancelled` (fail closed).
- **Sandbox is inherited, not weakened** — created sessions get
  `meta.cwd = workspace.path`, so DSH's per-session sandbox confines the
  agent's file effects to that workspace.
- **Localhost-first** — the HTTP server binds `127.0.0.1` by default.
- **Secret redaction** — all bridge logs and tool outputs pass through a
  redactor (sk-... keys, bearer tokens, key=value secrets, secret-shaped
  keys). The generated token is never logged.
- **No ChatGPT credentials** — the bridge never reads cookies, never drives a
  browser, never stores OpenAI session tokens.

---

## Approval behavior (concrete)

1. The DSH agent requests a permission. DSH emits `approval/request`.
2. The bridge (an answerer for its own sessions) parks the request; the
   session shows `waiting_for_approval` with
   `{approval_id, tool_name, call_id?, reason?}`.
3. ChatGPT calls `dsh_approve(session_id, approval_id, "approve")` →
   `allowed-once`; or `"reject"` → `rejected` and the call fails closed.
4. The agent's turn continues.

Sessions created by the web UI keep being answered by the web UI answerer;
the bridge only answers approvals for sessions it created. In a profile
where the web UI already owns the single user-questions provider slot,
questions flow through that provider instead (reported in `dsh_health`
capabilities).

## User question behavior

When the agent calls the ask-user tool, the bridge (as the registered
provider) parks the question; the session shows `waiting_for_user` with the
question text/options, and `dsh_answer_question` resolves it. Answers are
validated against the offered options.

## Long task behavior

`dsh_send_message` returns immediately with `{accepted: true}`. The agent
loop runs in the background; `dsh_get_task_status` polls
`queued -> running -> completed|failed|cancelled`. Cancellation goes through
DSH's own `agent.cancel({kind:'user'})`, which aborts the active turn
(turn-end reason `aborted`) or discards still-queued messages — DSH's
semantics, not a second task system.

---

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm test              # node --test (status derivation, view extraction,
                      #   redaction, workspace boundary, approvals/questions)
npm run dogfood       # full MCP client flow against a running bridge:
                      #   health -> workspaces -> create -> send -> status ->
                      #   result -> follow-up -> same session continues,
                      #   isolation, list/get, long-task cancel, redaction
npm run resume-test   # create marker session -> restart the DSH profile ->
                      #   continue the same session -> marker survives
npm run demo-flow     # two-step demo (analyze, then implement + test)
```

The dogfood/resume/demo scripts use the official `@modelcontextprotocol/sdk`
**client** over Streamable HTTP against the booted profile — the same
protocol ChatGPT speaks.

---

## Uninstall / disable

- **Disable:** in the profile's `cordis.patch.yml` add
  `- id: chatgpt-bridge` + `  disabled: true`, then restart the profile. The
  MCP endpoint disappears; DSH keeps running untouched (verified).
- **Uninstall:** `dsh plugin --profile chatgpt-bridge remove dsh-chatgpt-bridge`
  (or delete the profile directory). Bridge-created agents are disposed with
  the plugin; their **session logs remain persisted** and can be resumed
  later from any profile sharing `$DSH_HOME`.
- Sessions created by the bridge continue to exist and can be continued by
  the Web UI or any other entry point — DSH's session log is shared.

DSH core modifications: **0**.

---

## Common errors

| Symptom | Cause / fix |
| --- | --- |
| `401 unauthorized` | Wrong/missing bearer token; read `$DSH_HOME/chatgpt-bridge.token` or set `DSH_CHATGPT_BRIDGE_TOKEN`. |
| `WORKSPACE_NOT_FOUND` | The workspace is not registered in DSH; `dsh_list_workspaces` shows what is allowed. |
| `SESSION_NOT_FOUND` | Unknown session id (never created, or persistence not mounted). |
| `SESSION_NOT_LIVE` on cancel | The session is not loaded in this process; only live sessions can be cancelled. |
| `APPROVAL_NOT_FOUND` / `QUESTION_NOT_FOUND` | The decision was already taken or the bridge restarted (parked decisions are in-memory). |
| question provider slot taken (log) | A web UI is attached and owns user questions; answer them in the UI. |
| Port 3456 busy | Another bridge instance is running; change `port`. |
| Cold sessions show no title in `dsh_list_sessions` | Cold titles come from the projection cache; concurrent DSH profiles sharing the cache can clobber rows. Single-profile deployments get titles. |

---

## Current limitations

- First version is **ChatGPT -> DSH** only: it drives DSH sessions; it does
  not expose a full remote control plane (no file browsing, no arbitrary
  tool passthrough).
- Parked approvals/questions live in the bridge process; a bridge restart
  while something is parked resolves them `cancelled` (fail closed).
- `dsh_get_result.changed_files` is derived from the session log's tool
  calls (arguments of known editing tools) — data-driven, not a diff viewer.
- The `waiting_for_user` provider slot is single-slot; in a profile where
  the Web UI already owns it, questions flow through the UI.
- Stdio mode is supported, but the boot process must not print to stdout;
  prefer the HTTP transport unless a client requires stdio.
- Live ChatGPT validation was completed on 2026-08-14 through a tunneled MCP
  connection: ChatGPT discovered and invoked `dsh_health` and
  `dsh_list_workspaces`. The automated dogfood/resume flows additionally use
  the official MCP SDK client against the same Streamable HTTP endpoint.

## DSH compatibility

- Developed and verified against **DeepSeek Harness `0.1.0-rc.6`** (profile
  bundle `@deepseek-ai/dsh-base`), Node >= 22.
- Uses only public plugin seams; no DSH core files are modified.

---

## License

MIT
