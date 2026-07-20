# OWS-Native Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Restura's proprietary Flow model with a safely executable Open Workflow Specification workspace across the renderer, desktop, self-hosted runtime, and CLI.

**Architecture:** `workflow.ows.json` is the only executable workflow document and is normalized, validated, graphed, and serialized by the OWS SDK. Bindings are strict, non-secret references to saved requests; a platform dispatcher resolves them through Restura's existing protocol execution path. Layout is a non-semantic projection. The executable profile is fail-closed: unsupported controls and transports are rejected before persistence or execution.

**Tech Stack:** TypeScript, React, Zustand, Electron IPC, Node filesystem, CLI, Vitest, `@openworkflowspec/sdk`.

## Global Constraints

- OWS JSON is canonical; legacy Flow documents and custom graph semantics are unavailable.
- Never persist credentials or executable transport configuration in bindings or layout.
- Every executable request must use an existing policy-enforced Restura protocol path.
- Unsupported OWS features must be rejected during parse/profile validation, never deferred to execution.
- Web, self-hosted, Electron, and CLI capabilities must be explicit and tested.

### Task 1: Fail-closed profile and executor

**Files:** `shared/ows/workflow-profile.ts`, `shared/ows/bindings.ts`, `shared/ows/executor.ts`, and `shared/ows/__tests__/*`.

- [x] Write failing profile tests for inline call transport/auth fields, unsupported transports, unsupported controls, invalid bindings, and timeout cancellation.
- [x] Verify the tests fail against the permissive foundation.
- [x] Restrict the profile to controls and call kinds with a bounded implementation; parse with SDK validation before profile validation.
- [x] Replace the raw call callback contract with a typed trusted dispatcher that receives an approved binding only; compose task/workflow timeout and cancellation signals.
- [x] Run the focused OWS profile and executor suites.

### Task 2: Safe deterministic workspace artifacts

**Files:** `shared/ows/node/workspace.ts`, `shared/ows/node/__tests__/workspace.test.ts`.

- [x] Write failing tests for symlink traversal, plaintext binding fields, concurrent save isolation, byte-stable JSON, and unsupported IDs.
- [x] Verify failures against the current lexical writer.
- [x] Stage and validate a complete artifact set, reject symlinks/unsafe IDs, use unique temporary paths, atomically swap the complete artifact directory, and serialize companion JSON canonically.
- [x] Run the workspace suite.

### Task 3: Product-owned OWS model and safe request dispatch

**Files:** OWS store/model under `src/features/workflows/`, renderer protocol dispatcher, and their tests.

- [x] Write a failing integration test showing a binding-only OWS HTTP task resolves only a saved request and executes through the protocol registry with the caller signal. gRPC remains rejected because no bounded OWS gRPC dispatcher is implemented.
- [x] Replace the legacy workflow state shape, imports/exports, and execution selection with OWS document, bindings, and layout state.
- [x] Project SDK graph nodes to the editor, with synthetic start/end visual nodes only.
- [x] Run renderer workflow and protocol tests.

### Task 4: Desktop workspace, watcher, Git, and CLI integration

**Files:** Electron collection/workspace storage and Git allowlist, `cli/src/runner/collectionLoader.ts`, CLI OWS runner/tests.

- [x] Write failing integration tests for opening OWS artifacts, Git allowlist acceptance, and CLI discovery/execution. Existing collection-root watching applies to OWS artifacts without a second filesystem allowlist.
- [x] Register OWS directories as first-class workspace roots without widening arbitrary filesystem/Git access.
- [x] Add CLI discovery and fail-closed execution using the same core profile and binding resolver, exposed as `restura workflow run`.
- [x] Run Electron/CLI focused tests.

### Task 5: Remove legacy Flow surface and document capability boundary

**Files:** legacy Flow types/store/editor/executors/tests, workflow docs, capability source/docs.

- [x] Write failures proving legacy envelopes and legacy-only nodes cannot be imported, created, saved, or run.
- [x] Remove legacy workflow types, graph editing/execution, and compatibility imports; update sidebar/routes to OWS-only editor.
- [x] Document supported OWS profile and per-platform limits, then regenerate capability output if the source changes.
- [x] Run targeted tests, `npm run type-check:all`, `npm run lint`, `npm run architecture:check`, documentation build, and `npm run validate`.
