# ChatGPT Work Operator Layer

This fork keeps the upstream DSH security and approval model and adds a narrow operator layer for ChatGPT Work.

## Scope

- English (en-US) for operator-facing output.
- Autonomous feature-branch edits, commits, builds, tests, and iterative repair.
- Pending approval identity must remain exact; a changed action requires a fresh approval.
- Machine-readable capability discovery.
- Structured execution receipts.
- High-level goal delegation.
- Final-review handoff for independent ChatGPT/PStack verification.

Upstream protocol constants, code identifiers, paths, commands, model names and source quotations are not mechanically translated.

## Compatibility principle

Prefer additive MCP tools and metadata. Avoid changing existing upstream tool semantics so future upstream releases can be incorporated with minimal conflict.
