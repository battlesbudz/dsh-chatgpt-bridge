# Changelog

## 0.3.0 — next release

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
