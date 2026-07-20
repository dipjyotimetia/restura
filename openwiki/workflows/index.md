# OWS workflows

Restura workflows are a clean-slate, OWS-native orchestration feature. There
is no legacy linear workflow, proprietary Flow graph, migration path, or
compatibility executor. The Open Workflow Specification document is the sole
executable workflow definition.

The public capability boundary is documented in
[`docs/workflows.md`](../../docs/workflows.md). This page is a source map for
contributors.

## Data model and persistence

`src/store/useWorkflowStore.ts` keeps the renderer's validated OWS records:

- an SDK-normalized `OwsWorkflow` document;
- exact task-path-to-saved-request bindings;
- non-semantic layout; and
- ordinary collection and timestamp metadata.

For a normal browser collection, the record is persisted through the existing
Zustand storage adapter. For a desktop file-backed collection, the canonical
workspace artifacts are:

```
opencollection.yml
workflows/<workflow-id>/workflow.ows.json
workflows/<workflow-id>/bindings.restura.json
workflows/<workflow-id>/layout.restura.json
```

`shared/ows/node/workspace.ts` validates and atomically writes those artifacts.
It rejects non-portable IDs, links, stale paths, incomplete artifact sets, and
unknown files. `src/store/useFileCollectionStore.ts` loads them after the
workspace watcher is registered and saves/removes them as the collection is
synced.

## Supported profile

`shared/ows/workflow-sdk.ts` uses `@openworkflowspec/sdk` to parse, normalize,
validate, graph, and serialize persisted documents in Node workspace and CLI
paths. The renderer's CSP-safe `shared/ows/workflow-profile.ts` validates and
projects the same bounded profile without loading the SDK's dynamic code
generator. Restura deliberately executes only this safe profile:

- sequential `do`, `set`, and `wait` tasks;
- task and workflow timeouts, plus cancellation; and
- HTTP calls that reference a saved OpenCollection request through a
  `restura://saved-request` endpoint and a typed companion binding.

All other OWS controls and call transports are rejected before persistence and
execution. In particular, inline transport configuration, executable
extensions, opaque extras, schedules/triggers, inline credentials, arbitrary
scripts, and legacy graph semantics are unavailable.

## Execution

`shared/ows/executor.ts` interprets a validated document and gives the
renderer/CLI dispatcher only a task path, binding, method, cancellation signal,
and bounded timeout. It never passes raw OWS call configuration to a transport.

`src/features/workflows/hooks/useOwsWorkflowExecution.ts` resolves each
approved binding to an existing saved HTTP request and invokes the normal
protocol registry, retaining its auth inheritance and protocol policy.
`cli/src/runner/owsWorkspaceLoader.ts` discovers the same strict artifact
layout and `cli/src/runner/owsWorkspaceRunner.ts` dispatches through the CLI's
existing HTTP runner.

Electron IPC is exposed through `owsWorkspace` in the preload bridge. The main
process handler requires a registered collection watcher root and validates
every list/load/save/delete payload before reaching the Node workspace helper.

## Editor

`src/features/workflows/components/WorkflowBuilder.tsx` is a compact OWS JSON
editor with a bindings editor and safe graph preview. It may display
synthetic start/end nodes for orientation; these are never serialized as
workflow semantics. `WorkflowManager.tsx` provides create/import/export and
`WorkflowExecutor.tsx` renders bounded run results.

## Collection runner

The collection-level runner (`src/features/collections/lib/collectionRunner.ts`)
remains separate from OWS. It executes saved collection requests and
collection scripts; it is not a workflow compatibility layer.

## Change guidance

- Start with `docs/workflows.md`; do not expand the accepted OWS profile unless
  there is a bounded, policy-enforcing runtime dispatcher and test coverage for
  every platform that advertises it.
- Keep `shared/ows/` runtime-neutral. Electron filesystem access belongs in the
  main-process handler and `shared/ows/node/`; renderer code must not bypass
  IPC.
- Do not add a migration, hidden legacy importer, Flow node, or executable
  sidecar. Invalid/legacy workflow data is intentionally unavailable.
- Update the capability source and regenerate the matrix when the supported
  profile changes.

## Source map

| Concern | Files |
| --- | --- |
| OWS SDK/profile | `shared/ows/workflow-sdk.ts`, `shared/ows/workflow-profile.ts` |
| Bindings/layout | `shared/ows/bindings.ts` |
| Safe executor | `shared/ows/executor.ts` |
| File workspace | `shared/ows/node/workspace.ts` |
| Renderer store | `src/store/useWorkflowStore.ts` |
| File-collection integration | `src/store/useFileCollectionStore.ts` |
| Renderer execution | `src/features/workflows/hooks/useOwsWorkflowExecution.ts` |
| Editor UI | `src/features/workflows/components/{WorkflowBuilder,WorkflowManager,WorkflowExecutor}.tsx` |
| Electron IPC | `electron/main/handlers/ows-workspace-handler.ts`, `electron/main/preload/integration-api.ts` |
| CLI discovery/execution | `cli/src/runner/{owsWorkspaceLoader,owsWorkspaceRunner}.ts`, `cli/src/commands/workflow.ts` |
