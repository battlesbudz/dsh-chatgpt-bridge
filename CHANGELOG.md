# Changelog

## 0.4.1 — 2026-08-21

DSH 0.1.1-rc.1 compatibility release. Upgrades the `@deepseek-ai/dsh-*` dependency
family to `0.1.1-rc.1` across runtime dependencies and devDependencies, reinforces
wire-contract regression tests for the Web Gateway (`src/web-gateway.ts`), and verifies
full compatibility across Native Settings, RuntimeManager ownership/lifecycle invariants,
and the 15 MCP public tools.

### Changed

- **DSH Runtime Family Upgrade**: Unified all `@deepseek-ai/dsh-*` dependencies to `0.1.1-rc.1`
  (`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-presets`, `@deepseek-ai/dsh-llm`,
  `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-title`, `@deepseek-ai/dsh-agent-default-model`,
  `@deepseek-ai/dsh-session-persistence`, `@deepseek-ai/dsh-session-projection`,
  `@deepseek-ai/dsh-session-projection-cache`, `@deepseek-ai/dsh-user-approval`,
  `@deepseek-ai/dsh-user-questions`, `@deepseek-ai/dsh-workspace`).
- **Synchronized Lockfiles**: Regenerated and aligned both `package-lock.json` and `pnpm-lock.yaml`.

### Added

- **Web Gateway Wire Contract Regression Suite**: Added comprehensive test coverage for
  `apiProxy.events.mux` stream processing and `apiProxy.respond` client-response frames,
  including single/multi/custom user-question resolution, permission approval flow,
  session mismatch guards, gateway rejection handling, malformed envelope protection,
  and concurrent multi-session isolation without crosstalk.

## 0.4.0 — 2026-08-21

Native Settings + Tunnel Runtime Manager. The DSH Web settings surface now
has a **ChatGPT Bridge** section that configures, starts, stops, restarts and
diagnoses a plugin-owned `tunnel-client` runtime — no more hand-rolled
PowerShell. Bridge data plane and `authMode=token` are unchanged.

### Added

- **Existing-install auto-discovery**: Settings recognizes an already-present
  `tunnel-client` without requiring a manual executable path. Lookup order is
  configured path → `PATH` → well-known install directories (including
  `D:\Application\tunnel-client\`) → running `tunnel-client` image path
  (hint only; never adopted). Official tunnel-client profiles under
  `%APPDATA%\tunnel-client\` (or `~/.config/tunnel-client/`) prefill Tunnel
  ID and control-plane URL. `GET /config` exposes a non-secret `discovered`
  object; literal API keys in those profiles are ignored, `env:`/`file:`
  refs are reported only as a boolean.
- **Native Settings section** (`settings.section` id `chatgpt-bridge`, order 66):
  live status (bridge/tunnel/OpenAI/overall), config form (Tunnel ID, executable,
  auto-start, proxy, control-plane base URL), write-only Runtime API Key
  (Replace/Clear), Start/Restart/Stop, layered diagnostics and redacted log tail.
  The page now follows DSH settings recipes: fewer group cards, status as a
  2×2 chip grid with runtime actions in the same card, stacked fields for long
  values, title/control rows with native-style switches, and Chinese copy for
  the zh locale. Tunnel ID is write-only like Runtime API Key: the stored
  value is never echoed (masked field + configured pill); Save keeps the
  existing id when the replacement box is empty.
- **Independent control plane** under `src/control/`: ConfigStore (atomic,
  schema-versioned `runtime-config.json`), SecretStore (`secrets/runtime-api-key`,
  `secrets/mcp-authorization`; only `file:` references leak into config/profile),
  ProcessIdentity (pid + executable + startedAt + per-launch `runtimeInstanceId`;
  ownership verification = PID + normalized executable path + process start time),
  RuntimeManager (single RuntimeSnapshot authority, serialized start/stop/restart),
  TunnelRuntime interface with `ProcessTunnelRuntime` (default) and
  `FakeTunnelRuntime` (offline dev/test), profile generator, diagnostics,
  management routes.
- **Management API** `/_dsh/chatgpt-bridge/*`: `GET /status|/config|/logs`,
  `PUT /config`, `PUT|DELETE /secret/runtime-api-key`, `POST /start|/stop|/restart|/diagnostics`.
  Loopback-only + Host/Origin/Content-Type/custom-header checks (CSRF); no CORS wildcard.
- **Client bundle** `./lib/client.js` (module-loader format, `dsh.client` manifest).

### Fixed

- **External-ready status and diagnostics no longer trust the wrong key source**: an observed,
  ready external `tunnel-client` may use its own official profile/environment
  key. A stale optional key in the plugin store no longer overrides that live
  readiness with `runtime-api-unauthorized`. Plugin-owned startup remains
  strict: without an external process it still spawns its own runtime, requires
  the plugin Runtime API Key, and preserves unauthorized/degraded handling.
- **Plugin-owned Runtime API Key validation now probes the tunnel resource**:
  the control-plane origin root is not an authentication check and can return
  401 even after `tunnel-client` has authenticated successfully. Status and
  diagnostics now probe `/v1/tunnel/<Tunnel ID>`, matching the metadata request
  used by the managed client, while preserving strict 401/403 handling. Managed
  runs and doctor also pin `--control-plane.api-key=file:...`, preventing an
  inherited `CONTROL_PLANE_API_KEY`/`OPENAI_API_KEY` from overriding the plugin
  SecretStore value. HTTPS-over-proxy probes now also preserve the target Host
  header inside the CONNECT tunnel instead of accidentally sending `localhost`.
- **Native Settings form poll no longer reverts unsaved edits**: the 2s
  refresh used to rewrite Tunnel ID / Auto-start / Enable-proxy from
  `GET /config`, so ticking Enable proxy snapped back as soon as the
  in-flight poll landed. Status still polls live; the form hydrates on
  open and after a successful Save.
- **OpenAI status is not `error` merely because the Runtime API key is
  empty** while the tunnel is stopped. That painted a red OpenAI failure
  on a connection that was never probed. Missing key is `unknown` until
  the tunnel is ready (then it is a real blocking error). The Status
  card shows *not configured* in that case.
- **Settings Status now observes an already-running official
  `tunnel-client`**: a process started with `--profile dsh-chatgpt-bridge`
  (key in `%APPDATA%\\tunnel-client\\*.yaml`, health on `listen_addr`,
  proxy via `--control-plane.http-proxy`) was shown as Tunnel=stopped /
  OpenAI=error / key=— even while `/readyz` was 200 and ChatGPT could
  talk. Status now probes that health base, reports
  `running (external)` without taking ownership, treats a non-empty
  official `api_key` as configured (value never copied), and infers
  OpenAI=connected from a ready tunnel. Start/Stop/Restart do not spawn
  or kill that process.
- **Native Settings client React loader**: `BridgeSection` now acquires React
  via `const React = require('react')` inside the ModuleLoader factory, not
  from a non-existent browser-global React. Without this, the
  `settings.section` slot registered on DSH 0.1.0-rc.7 but crashed on click
  (`ReferenceError: React is not defined`) and the right pane stayed blank.
  The client render test now simulates the real factory `require` (no global
  React) and asserts the `'react'` dependency is declared.
- **Native Settings section actual rendering**: `Section`/`Row` are now invoked
  through `React.createElement(Section, ...)`, so their trailing children land
  in `props.children` instead of being dropped by a plain function call.
  Status lines, Tunnel ID / Executable inputs, the Runtime API Key control,
  the proxy form and every action button render as real children. A client
  render smoke test (minimal fake React, no jsdom/bundler dependency) guards
  against regression.
- **`overall` state machine**: only `openai=connected` may produce
  `overall=ready` on a live ready tunnel. `unknown`/`unreachable`/
  `unauthorized` map to `degraded`, `error` maps to `overall=error` — an
  external OpenAI probe failure can never default-fallthrough to `ready`.
  Parameterized matrix tests plus a running-runtime regression test.
- **`restart()` fail-closed**: when the owned runtime cannot be confirmed
  stopped (e.g. `stale-process-identity`, `tunnel-stop-timeout`), restart no
  longer discards the handle and spawns a new tunnel; it returns an error
  snapshot with the previous process identity retained. FakeTunnelRuntime
  tests cover stop-success (exactly one new start), stale identity and stop
  timeout.
- **Failed-start cleanup fail-closed (ownership)**: `safeStopHandle()` only
  releases the runtime handle after shutdown is confirmed. A failed-start
  cleanup whose `stop()` throws (`stale-process-identity`,
  `unknown-start-time`, `start-time-mismatch`, `tunnel-stop-timeout`, ...)
  now retains the handle and surfaces the cleanup error instead of pretending
  the process is gone; while an unresolved owned handle exists, a later
  `start()`/`restart()` refuses to call the backend start again (the guard
  lives in RuntimeManager, not the backend). `dispose()` keeps the same rule
  and logs a redacted shutdown failure. Regression tests cover cleanup
  success, stale identity, blocked second start, stop timeout, and retry
  after confirmed cleanup.
- **Process identity PID-reuse protection**: verification now also compares
  the live process start time against the recorded one (tolerance-based), not
  just the PID + executable path. A re-used PID with a matching path but a
  different start time, or an unreadable start time, fails closed.
- **Auto-start timer lifecycle**: the delay before auto-start is held in a
  cancellable handle and cleared by `dispose()`; a disposed plugin can no
  longer spawn a tunnel from a pending auto-start.
- **Diagnostics**: `RuntimeManager.diagnostics()` now invokes the
  `tunnel-client doctor` (`doctor()` on the runtime backend) and appends its
  normalized, redacted steps to the layered checks. A doctor failure is a
  structured failed step, never a crash.
- **Lifecycle/ownership error latch**: `stale-process-identity`,
  `start-time-mismatch`, `unknown-start-time` and `tunnel-stop-timeout` stay
  latched while the manager still holds an unresolved runtime handle. Ordinary
  polling/`refresh()` can no longer re-derive `overall=ready` (a contradictory
  `READY + lastError` snapshot) just because the runtime later reports
  healthy/ready — health/readiness is not an ownership resolution. The latch
  clears only on explicit resolution: confirmed stop (handle released),
  confirmed cleanup, or a successful fresh start after ownership was resolved.
- **Status probe provenance**: a thrown `runtime.status()` probe is treated as
  unknown state, never as confirmed process exit. `refresh()` retains the
  ownership handle through status uncertainty (surfacing `status-failed`
  fail-closed) and releases it only when a successful probe confirms the
  runtime is gone (`status=stopped` or `lastError=unexpected-exit`) or a stop
  succeeds. A transient status-query failure can therefore no longer orphan a
  still-running runtime or permit a duplicate backend start; when the same
  retained handle can be probed again, the snapshot recovers normally.
- **Hard-kill identity re-verification**: graceful stop used to wait several
  seconds then `SIGKILL` / `taskkill /T /F` the same PID without checking
  whether the OS had reused it. Every destructive kill, including startup
  health-URL timeout cleanup, now re-verifies pid + executable + start time
  immediately beforehand. Mismatch, unreadable probe, thrown probe, or a
  missing process fails closed (no hard kill; structured `stale-process-identity`).
  There is no production skip-verify flag.
- **Diagnostics status-probe provenance**: `RuntimeManager.diagnostics()`
  (and `POST /diagnostics`) no longer reject the whole request when
  `runtime.status()` throws. They return a structured `status-failed` step,
  keep `owned=true`, and refuse a second spawn — same contract as `refresh()`.
- **Windows discovery path semantics**: well-known / PATH / profile discovery
  now uses `path.win32` / `path.posix` according to the *simulated* platform,
  so Windows install locations such as `D:\Application\tunnel-client\` resolve
  correctly on Linux/macOS CI.
- **Management API unexpected errors**: start/stop/restart/diagnostics/status
  handlers catch implementation errors and return JSON `{ ok: false, error }`
  instead of an unhandled rejection. Operational failures stay on the
  RuntimeSnapshot (`lastError`). Stop failure does not report `stopped`;
  start-after-spawn failure adopts the leftover handle rather than orphaning it.

### Security

- Runtime API key never enters `runtime-config.json`, profile YAML (only `file:` refs),
  CLI argv, GET responses, RuntimeSnapshot, logs or exceptions.
- `tunnel-client` is stopped only after identity re-verification; never killed by
  port and never by image name. DSH unload stops the plugin-owned runtime.
- No `authMode: none`, no `0.0.0.0` bind, no CORS `*` on the management API.

### Compatibility

- Bridge `bridge.ts` / `mcp.ts` / `http.ts` / `config.ts` behavior unchanged.
- MCP tools, Goal Control Plane and session semantics unchanged; existing tests
  keep passing. Runtime config lives in its own file, not the Bridge ConfigSchema.

## 0.3.0 — 2026-08-15

Goal Control Plane. ChatGPT can revise, defer, constrain, and resume one long-lived Goal on the same DSH session.

> This release also folds in the stabilization work that was originally
> tracked under a "0.2.1" heading. **0.2.1 was never released** — it was
> never tagged (tags: `v0.1.0`, `v0.2.0`) and never published to npm
> (published versions: `0.1.0`, `0.2.0`). All of its changes ship in 0.3.0.

### Added

- First-class Goal revision history (immutable snapshots). `dsh_start_goal(..., session_id=existing)` is a revise (revision +1).
- `dsh_update_goal` (15th tool): `action=revise|defer|resume`. `session_id` is required; resume cannot create a session.
- Execution modes: `standard` (default), `minimal`, `strict`.
- Structured constraints: `read_only`, `allow_workspace_scan`, `max_changed_files`, `allowed_actions`, `forbidden_actions`. Constraints only tighten DSH policy.
- Formalized step graph: stable ids, `ready`/`deferred`/`skipped`, release-shaped DAG reused from v0.2.1.
- Bounded Goal history sidecar at `$DSH_HOME/chatgpt-bridge/goals/<session_id>.json`. Secrets/OTP redacted. Wire slice last 20 events.
- Supervision fields on start/wait/status/session: `goal` `{goal_id, revision, mode}` and `execution` `{current_step, runnable_steps, blocked_steps, deferred_steps}`.
- Compact `[Goal] rev N · mode` banner in the user message (visible in DSH Web transcript).

### Fixed

- Supervised Agent turns now state that the injected `[Goal]` block is the authoritative Goal. Native `get_goal` is a different namespace; a null result must not override Bridge `goal_id` / revision / mode / constraints. Minimal mode treats `get_goal` as an unnecessary control-plane query.
- `pwsh` is classified as `process.exec`, same as `powershell` / `bash` / `shell` / `cmd`. Strict Goals with `forbidden_actions: ["process.exec"]` no longer allow the DSH `pwsh` tool.

### Compatibility

- v0.2.x callers of `dsh_start_goal` / `dsh_wait_goal` / `dsh_stop_goal` keep working.
- Public Goal status vocabulary unchanged. Completed-with-deferred stays `completed` + `deferred_steps`.
- No DSH Core changes. Sidecar is additive; old sessions reconstruct as revision 1 / standard.

## 0.2.1 — unreleased (folded into v0.3.0)

**Never released.** No `v0.2.1` tag, no release commit, not published to npm
(published versions: `0.1.0`, `0.2.0`). Kept here for history: this is the
stabilization work that ships inside v0.3.0. No new MCP tools; public status
vocabulary unchanged.

### Fixed

- Goal todos are reconciled against structured `tool/call` / `tool/result` facts before `dsh_wait_goal`, `dsh_get_session`, and `dsh_get_task_status`. Completed actions no longer stay `pending` when the agent forgot a `todo/write`. Assistant summary text is never used as a success signal.
- Waiting / blocked steps stay `in_progress` and are not marked completed.
- `blocked` is no longer an automatic Goal-wide terminal when independent steps remain (release-shaped: `npm publish` ∥ `GitHub Release` after tag).
- Temporary release worktrees / `_release-verify` / release notes / pack tarballs created by the Goal are cleaned up on terminal or `dsh_stop_goal`. Cleanup failure becomes `cleanup_warning` and does not fail an already successful release.

### Added (additive fields only)

- `dsh_wait_goal.progress_delta` — bounded since/until seq, todo changes, new events, new approvals/questions/files.
- `blocked` — step, reason, resume_condition, scope, independent_steps_available.
- `deferred_steps`, `blocked_steps`, `remaining_runnable_steps`.
- Re-arm via existing `dsh_start_goal(..., session_id=existing)` can defer a branch (e.g. npm 2FA) and continue the rest.

### Compatibility

- Still 14 ChatGPT tools. No renamed tools, no deleted fields, no DSH Core changes.
