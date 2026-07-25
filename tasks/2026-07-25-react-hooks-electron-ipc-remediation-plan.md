# Implementation Plan: Renderer, Hook, and Electron IPC Remediation

## Overview

Resolve the eleven findings in the 2026-07-25 audit without changing product
capability support, persisted schemas, shared-protocol behaviour, or the public
request model. Work starts with the privileged Electron ownership boundary,
then IPC bridge integrity, renderer correctness/security, and independent hook
lifecycle repairs.

This plan does not add channels, dependencies, a generic controller framework,
raw Electron exposure, or browser persistence. The completed React-controller
work from PR #565 remains out of scope.

## Contract Decisions

### Per-window IPC ownership

Every long-lived resource belongs to the webContents ID that created it. Only
that window may read from, mutate, cancel, disconnect, or replace it. A
wrong-owner operation is indistinguishable from a missing resource: invoke
handlers retain their current failure shape/message and fire-and-forget
operations ignore it. This prevents existence leaks across trusted windows.

Introduce a typed internal registry/handler seam for owner-aware lookup,
cancellation, and same-ID replacement. The exact names may differ, but the
comparison is centralised, every ownership-sensitive invoke receives event via
createValidatedEventHandler, and input/trusted-sender validation still occurs
first. This is an internal contract only; no renderer API expands.

### Preload and renderer contracts

- Capture and collection event subscriptions return individual disposers. The
  existing global remove-listener API is removed after known consumers migrate.
- Existing IPC command values and externally observable return payloads remain
  stable. Actual registration/teardown uses canonical IPC constants.
- Request completions target their origin tab and safely no-op after it closes;
  existing active-tab mutations stay for genuine active-tab UI actions.
- MCP teardown clears the persisted connection state and ignores late work from
  the previous connection.
- Response preview remains sandboxed and receives a deny-by-default CSP that
  permits only verified presentation resources.
- Async hooks own a generation or abort controller; only the latest live
  operation commits state.

## Dependency Graph

~~~text
Owner-aware registry seam
    ├─ WebSocket / Socket.IO
    ├─ SSE / MCP
    ├─ Kafka / MQTT
    └─ gRPC / AI / AI Lab
              │
              ▼
      Electron ownership checkpoint

Preload unsubscribe + canonical registrations
              │
              ▼
         Bridge checkpoint

Target-tab store API ──> request runner/page
MCP teardown + response-preview CSP
              │
              ▼
      Renderer correctness checkpoint

Independent hook lifecycle/race slices
              │
              ▼
       Full parity and coverage gates
~~~

## Phases and Checkpoints

### Phase 1: Electron ownership (Tasks 1-6)

Define the owner-aware internal seam first, then apply it one protocol family at
a time. Every audited ID-only read/mutate/cancel/reconnect path must become
owner-aware before this phase closes.

### Checkpoint A

- Two-sender regression tests cover every audited protocol family.
- The owning window retains current behaviour; the non-owner cannot learn
  whether a resource exists.
- Focused Electron tests, type-check-all, lint, and architecture check pass.

### Phase 2: IPC bridge integrity (Tasks 7-8)

Make event cleanup composable and canonical channel use mechanically
verifiable, without widening bridge privileges.

### Phase 3: Renderer data and response isolation (Tasks 9-11)

Fix origin-tab response routing, MCP cleanup state, and response-preview CSP.

### Checkpoint B

- Focused renderer and preload tests cover all Phase 2-3 regressions.
- A browser test proves hostile response preview content cannot make a network
  request while intended local rendering remains functional.
- Static gates pass.

### Phase 4: Hook lifecycle safety (Tasks 12-16)

Repair the independent error, unmount, and stale-result paths. These slices can
be parallelised only after Task 9 lands, because it adds the shared target-tab
store contract.

### Phase 5: Integrated verification (Task 17)

Run full validation, web E2E, and Electron E2E. Preserve existing coverage and
uncovered-branch budgets; do not relax a gate.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Shared owner guard changes a handler failure contract | High | Test owner, non-owner, and nonexistent-resource cases against existing result shapes. |
| Same-ID reconnect disposes another window resource | High | Make replacement explicitly owner-aware and test it before protocol adoption. |
| CSP blocks useful rendering | Medium | Start deny-by-default; allow only verified inline/data resources and test real fixtures. |
| Target-tab actions change active-tab UI | High | Add separate targeted mutations; retain and test active-tab actions. |
| Async cleanup changes timing | Medium | Use deferred-promise tests for unmount, stale completion, and errors before implementation. |
| Electron fix becomes unreviewable | Medium | One protocol family per PR, each with a two-window regression test. |

## Publication Strategy

Use one draft PR per independently verifiable slice: ownership foundation;
each protocol ownership adoption; bridge contract; renderer correctness; and
each hook-lifecycle family. Do not combine dependency, visual, persistence, or
capability work with these fixes.
