# Implementation Plan: Production-grade React component remediation

## Overview

This plan resolves the accessibility and test-signal defects identified in the renderer review, then removes React controller-file-size debt through feature-owned, behaviour-preserving extractions. It is intentionally a refactor programme, not a UI redesign: request execution, persistence, Electron IPC, and web/self-hosted/desktop capability behaviour remain unchanged.

## Architecture Decisions

- Keep routes as the composition and lazy-loading boundary. Feature modules own their controllers, sections, hooks, and pure helpers.
- Prefer native `button` elements and valid tab semantics over ARIA-role simulations. Tab actions must be siblings of the tab control.
- Decompose by cohesive domain section, not by generic presentational framework. Extract pure logic before stateful view sections where that reduces dependencies.
- Preserve existing public exports during migration with thin re-exports only when needed; delete the compatibility shim in the same or immediately following slice.
- Use the existing 800-line policy as the exit criterion. Remove a React file from the grandfathered list when it is below the limit; do not raise allowances.

## Dependency Graph

```text
Tab semantics + async-test signal
        │
        ├── shared shell / settings extraction
        │       └── collection and protocol controller extraction
        │               └── AI Lab controller extraction
        │                       └── final size-ratchet and browser verification
        │
        └── regression-test conventions applied to every extraction
```

The accessibility and test work runs first because it establishes the interaction and test conventions used by every later slice. Settings, collections, protocol clients, and AI Lab controllers are independent after that foundation, but should land as one focused PR per controller family to avoid overlapping route/store changes.

## Phases and Checkpoints

### Phase 1: Correctness and test signal

- [ ] Tasks 1-2 in `tasks/todo.md`

### Checkpoint: Interaction foundation

- [ ] Tab save/close actions are separately focusable native controls, with no nested interactive descendants.
- [ ] The three currently warning-producing suites are clean.
- [ ] `npm run type-check:all && npm run lint && npm run test:run` pass.

### Phase 2: Shared and collection controller decomposition

- [ ] Tasks 3-8 in `tasks/todo.md`

### Checkpoint: Shared/collection architecture

- [ ] `SettingsDrawer` and collection `Sidebar` are composed from feature-owned modules below the policy limit.
- [ ] Existing settings, import/export, collection, history, workflow, and keyboard behaviours are retained.
- [ ] `npm run architecture:check && npm run test:coverage && npm run build` pass.

### Phase 3: Protocol controller decomposition

- [ ] Tasks 9-15 in `tasks/todo.md`

### Checkpoint: Protocol architecture

- [ ] Kafka, MQTT, MCP, Network Console, and Auth components no longer use React grandfathering.
- [ ] No platform-only capability crosses into web code; protocol request behaviour is unchanged.
- [ ] Focused protocol tests plus `npm run type-check:all`, lint, and `architecture:check` pass.

### Phase 4: AI Lab and closeout

- [ ] Tasks 16-20 in `tasks/todo.md`

### Checkpoint: Complete

- [ ] No React source remains over 800 lines or listed as grandfathered.
- [ ] No React `act(...)` warning is emitted by the full test run.
- [ ] `npm run validate` and applicable web/Electron Playwright suites pass.
- [ ] A fresh review confirms feature ownership, accessibility, performance boundaries, and parity.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Splitting controllers changes store subscriptions or causes excess re-renders | High | Preserve selectors, add targeted render/interaction tests, and profile the hot stream/list surfaces before changing memoisation. |
| Moving settings sections breaks route imports or deep links | High | Keep `SectionId` and the drawer public API stable; test every initial section. |
| Refactors accidentally change Electron-only behaviour | High | Keep platform checks at the feature boundary and run Electron E2E for affected surfaces. |
| Large refactors become unreviewable | Medium | One controller family per PR; no task is larger than five likely files. |
| Size exemptions are removed before the source is actually below the cap | Medium | Run `architecture:check` in every task and alter the policy only in the completing task. |
| Async test warning fixes mask a real lifecycle issue | Medium | First reproduce the warning, await/cancel the actual async source, then assert the user-visible postcondition. |

## Publication Strategy

Use one branch and draft PR per independently verifiable controller family: interaction/test foundation, settings, collections, protocol clients, and AI Lab. Each PR must include its focused regression tests and a fresh architecture review; do not combine visual redesign or dependency changes with these refactors.
