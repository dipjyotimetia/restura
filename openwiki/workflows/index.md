# Workflows

Workflows chain requests, run scripts, extract variables, apply retries, and branch on conditions. Restura supports both a legacy **linear** workflow and a **graph/DAG** workflow (the Flow canvas).

---

## Data model

The workflow store is `src/store/useWorkflowStore.ts`. A `Workflow` contains:

- `id`, `name`, `description`
- `requests: WorkflowRequest[]` — linear list (legacy)
- `graph?: WorkflowGraph` — optional DAG definition
- Variable extraction rules per step
- Execution history

The store wraps `zundo` for undo/redo.

### Linear `WorkflowRequest`

A step in a linear workflow references a request plus:

- retry count and delay
- pre-condition script
- delay before/after
- variable extractions (JSONPath, regex, header, body)

### DAG `WorkflowGraph`

Defined in `src/features/workflows/lib/flowTypes.ts`:

- `nodes: FlowNode[]`
- `edges: FlowEdge[]`
- `variables?: Variable[]`
- exactly one `start` node, at least one `end` node

Node kinds include `request`, `condition`, `switch`, `parallel`, `forEach`, `loop`, `tryCatch`, `subWorkflow`, `setVariable`, `delay`, `transform`, `template`, `display`, `sseSubscribe`, `wsExchange`, `mcpCall`.

The graph shape is versioned via `CURRENT_GRAPH_VERSION`. The current validator hardcodes version 1; bumping it requires adding a migration or existing graphs will fail to load.

---

## Execution engines

### Linear executor (`src/features/workflows/lib/workflowExecutor.ts`)

- Iterates `workflow.requests`.
- Evaluates preconditions via `evalScriptBoolean`.
- Executes each HTTP step with retry logic.
- Extracts variables after each step.
- Stops on first non-2xx by default.
- Honors `pm.execution.setNextRequest` flow control.
- Refuses to run workflows that define `workflow.graph`.

### DAG executor (`src/features/workflows/lib/dagExecutor.ts`)

- Traverses `workflow.graph` starting from the `start` node.
- Single-token traversal via `walkFrom` / `walkOutgoing`.
- Routes through `condition` and `switch` nodes by stashing branch labels in temporary variables.
- Handles `parallel` fan-out via a dedicated `runParallel` handler.
- Supports nested `subWorkflow` nodes with recursion guard.
- SSE subscribe, WebSocket exchange, and MCP call nodes are implemented via `startStream` handles from their respective protocols.
- Live status, logs, and variables are tracked in `src/features/workflows/store/useFlowRunStore.ts`.

### Run hook (`src/features/workflows/hooks/useWorkflowExecution.ts`)

Seeds variables from globals, the active environment, and linked collection variables, then dispatches to `executeDag` if `workflow.graph` exists, otherwise to `executeWorkflow`.

---

## Validation

Two validation layers exist:

1. `src/features/workflows/lib/validators.ts` — structural validation for linear workflow steps.
2. `src/features/workflows/lib/flowValidators.ts` — recursive Zod schema for DAGs:
   - exactly one `start`
   - at least one `end`
   - acyclicity
   - recursion-cycle detection for `subWorkflow` references
   - nested subgraph validation

`src/features/workflows/hooks/useGraphValidation.ts` shares validation between the UI and executor.

---

## Flow canvas

The visual workflow editor is under `src/features/workflows/components/flow-canvas/`:

- `FlowEditor.tsx` — canvas wrapper using `@xyflow/react`.
- `FlowCanvas.tsx` — node/edge rendering.
- `FlowToolbar.tsx` — controls.
- `FlowInspector.tsx` — selected node editor.

AI graph generation lives in `src/features/workflows/lib/aiGraphGen.ts`.

---

## Console mirroring

`src/features/workflows/lib/consoleMirror.ts` feeds workflow execution logs into the console store so users can see per-step output in a central panel.

---

## Collection runner

The collection-level runner (`src/features/collections/lib/collectionRunner.ts`) reuses the same variable-scope model and script executor as workflows. It supports:

- iteration data / CSV-driven runs
- collection and folder-level scripts
- variable precedence `globals < environment < collection < iteration data`
- same-run environment/local and collection-variable carry-forward via `shared/collections/variable-mutations.ts`
- HTTP and unary gRPC execution; streaming/connection protocols are reported as explicit skips
- folder ancestry in `pm.execution.location.folderPath` and explicit completed/aborted run outcomes
- protocol options narrowing in `src/features/scripts/lib/pmRunContextOptions.ts`

The CLI runner (`cli/src/runner/runner.ts`) runs the same logic headlessly with multiple reporter targets. See [Operations](../operations/index.md#cli).

---

## Recent work to be aware of

Recent PRs hardened the Flow feature:

- Concurrency fixes in parallel branch execution and the Flow run store.
- Desktop parity for SSE and WebSocket protocol nodes.
- Graph validation deduplication and new tests (`flowValidators.test.ts`, `validators.test.ts`).
- `consoleMirror.ts`, `useGraphValidation.ts`, and validator memo cleanup (PR #425).

When changing workflow or variable code, run the workflow-related Vitest suite and the workflow e2e specs.

---

## Change guidance

- If you change `WorkflowGraph` shape, update `CURRENT_GRAPH_VERSION` **and** add a migration. The current validator hardcodes version 1; without a migration, existing graphs will fail to load.
- If you add a node kind, add it to `flowTypes.ts`, `flowValidators.ts`, and `dagExecutor.ts` dispatch.
- If you touch variable extraction or scoping, run `src/features/workflows/lib/__tests__/dagExecutor.test.ts` and `src/store/__tests__/useWorkflowStore.saveExecution.test.ts`.
- If you change auth inheritance in workflows, test both folder-level inherited auth and request-level explicit auth.

---

## Source map

| Concern             | Files                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow types      | `shared/types/index.ts`, `src/features/workflows/lib/flowTypes.ts`                                                                               |
| Workflow store      | `src/store/useWorkflowStore.ts`, `src/store/useCollectionRunStore.ts`                                                                            |
| Linear executor     | `src/features/workflows/lib/workflowExecutor.ts`, `src/features/workflows/hooks/useWorkflowExecution.ts`                                         |
| DAG executor        | `src/features/workflows/lib/dagExecutor.ts`                                                                                                      |
| Graph validation    | `src/features/workflows/lib/flowValidators.ts`, `src/features/workflows/lib/validators.ts`, `src/features/workflows/hooks/useGraphValidation.ts` |
| Variable extraction | `src/features/workflows/lib/variableExtractor.ts`                                                                                                |
| Script helpers      | `src/features/workflows/lib/scriptHelpers.ts`                                                                                                    |
| Retry / abort       | `src/features/workflows/lib/retryHelpers.ts`                                                                                                     |
| AI graph generation | `src/features/workflows/lib/aiGraphGen.ts`                                                                                                       |
| Collection runner   | `src/features/collections/lib/collectionRunner.ts`                                                                                               |
| CLI runner          | `cli/src/runner/runner.ts`                                                                                                                       |
| Flow UI             | `src/features/workflows/components/flow-canvas/{FlowCanvas,FlowEditor,FlowToolbar,FlowInspector}.tsx`                                            |
| Legacy UI           | `src/features/workflows/components/{WorkflowBuilder,WorkflowExecutor,WorkflowStep}.tsx`                                                          |
