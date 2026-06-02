# ADR 0015: QuickJS WASM Script Sandbox

**Status:** Accepted, 2026-06-02

## Context

Pre-request and test scripts are user-authored JavaScript that also travels inside shared collections — so a script you import from someone else runs on your machine. Running it on the renderer's main thread (or via `eval`/`Function`) would give it the DOM, the network, and the user's storage. [ADR 0004](./0004-security-hardening.md) removed an earlier source-level regex blocklist of "dangerous patterns" because a blocklist is not a security boundary — it's trivially bypassed and gives false confidence. That left the question: what *is* the boundary?

## Decision

Execute all user scripts inside a **QuickJS WASM sandbox** (`src/features/scripts/lib/scriptExecutor.ts`). The VM has no DOM, no filesystem, and no ambient network — capabilities are granted only through an explicit host API (`rs.*`, with a Postman-compatible `pm.*` alias), and the VM is memory- and execution-time-capped. Anything the script can reach (e.g. `rs.sendRequest`, which is itself SSRF-guarded; `rs.vault`, desktop-only) is a deliberately exposed, audited capability rather than an ambient one.

The sandbox — not source inspection — is the security boundary.

## Consequences

**Positive**
- A malicious or buggy script can't touch the DOM, the filesystem, the network (except through guarded host APIs), or escape its memory/time budget.
- Imported collections are safe to run; the boundary holds regardless of what the script source looks like.
- Postman `pm.*` compatibility is provided over the same controlled surface, easing migration.

**Negative**
- QuickJS WASM adds bundle weight and a marshalling cost between the VM and the host.
- Every capability scripts need (cookies, sub-requests, vault, visualizer) must be explicitly bridged into the VM; there is no "just use the browser API" shortcut.
- The CLI does not yet bundle the sandbox, so test scripts don't run there (noted in [ADR 0005](./0005-cli-runner.md)).

## References
- Code: `src/features/scripts/lib/scriptExecutor.ts`
- Docs: docs-site `/guides/scripts/`, `/reference/postman-compat/`
- Related: [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0005 (CLI runner)](./0005-cli-runner.md)
