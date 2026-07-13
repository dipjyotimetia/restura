# AI Lab Unified Run Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AI Lab's disconnected prompt-eval and agent-suite lifecycle handling with one cancellable, report-persisting run engine while closing every Critical, Important, and Minor finding from the fresh PR #480 review.

**Architecture:** A renderer run engine owns job identity, cancellation, progress, and persistence while existing eval and agent executors remain pluggable. Renderer-generated operation IDs connect `AbortSignal` to sender-owned Electron cancellation, and HTTP execution carries the same signal through the normal transport boundary. Shared evaluation gains honest budgets and task-aware grading; desktop adapters provide conservative per-model capabilities and known-only pricing.

**Tech Stack:** TypeScript strict mode, React 19, Zustand persist, Zod, Vitest, Electron IPC, shared protocol orchestrators, Restura HTTP executor, Commander CLI.

## Global Constraints

- AI Lab remains Electron-only. Capability rows must not imply web or self-host support.
- The shared agent runtime remains backend-agnostic and must not import renderer, Electron, Zustand, or Node APIs.
- Existing shared SSRF, header, auth, redirect, secret-handle, and request-execution boundaries remain authoritative.
- Renderer code never resolves secret-handle plaintext.
- MCP and sandbox runtime capability rows remain disabled until concrete implementations ship.
- Existing prompt evaluation behavior and stored reports migrate without data loss.
- Unsupported capabilities, prices, token usage, judge quorum, and suite semantics fail closed.
- Every production behavior change begins with a failing regression test and a verified red state.
- Run localhost and Electron integration checks outside the sandbox.

---

### Task 1: Add the unified run lifecycle engine

**Files:**

- Create: `src/features/ai-lab/run-engine/types.ts`
- Create: `src/features/ai-lab/run-engine/runEngine.ts`
- Create: `src/features/ai-lab/run-engine/__tests__/runEngine.test.ts`
- Modify: `src/features/ai-lab/store/useAiLabUiStore.ts`

**Interfaces:**

- Produces `RunKind`, `RunStatus`, `RunFailure`, `RunJobSnapshot`, `RunExecutorContext`, and `RunEngine`.
- `RunEngine.start(kind, executor)` returns `{ jobId, result }`.
- `RunEngine.cancel(jobId)` synchronously enters `cancelling` and aborts the owned controller.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('cancellation wins over a late executor success', async () => {
  let finish!: (value: string) => void;
  const engine = new RunEngine<string>();
  const run = engine.start(
    'agent-suite',
    async () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  engine.cancel(run.jobId);
  finish('late success');
  await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
  expect(engine.get(run.jobId)?.status).toBe('cancelled');
});

it('bounds progress and preserves structured failures', async () => {
  const engine = new RunEngine<string>();
  const run = engine.start('eval', async ({ reportProgress }) => {
    reportProgress(2);
    throw new Error('provider unavailable');
  });
  await expect(run.result).rejects.toThrow('provider unavailable');
  expect(engine.get(run.jobId)).toMatchObject({ status: 'error', progress: 1 });
});
```

- [ ] **Step 2: Run the red test**

Run: `npx vitest run src/features/ai-lab/run-engine/__tests__/runEngine.test.ts`

Expected: FAIL because `RunEngine` does not exist.

- [ ] **Step 3: Implement the lifecycle contract**

```ts
export type RunKind = 'eval' | 'agent-suite';
export type RunStatus =
  'queued' | 'running' | 'cancelling' | 'passed' | 'failed' | 'error' | 'cancelled';

export interface RunExecutorContext {
  jobId: string;
  signal: AbortSignal;
  reportProgress(progress: number): void;
}

interface InternalJob<Result> extends RunJobSnapshot<Result> {
  controller: AbortController;
}

export class RunEngine<Result> {
  private readonly jobs = new Map<string, InternalJob<Result>>();

  start(kind: RunKind, executor: (context: RunExecutorContext) => Promise<Result>) {
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job = createInternalJob<Result>(jobId, kind, controller);
    this.jobs.set(jobId, job);
    return { jobId, result: this.execute(job, executor) };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.status)) return false;
    job.status = 'cancelling';
    job.controller.abort(new DOMException('Run cancelled', 'AbortError'));
    return true;
  }
}
```

`execute` clamps progress to `[0, 1]`, rejects late success after abort, and records `{ message, at }` for non-abort failures.

- [ ] **Step 4: Run lifecycle and UI-store tests**

Run: `npx vitest run src/features/ai-lab/run-engine/__tests__/runEngine.test.ts src/features/ai-lab/store/__tests__/useAiLabUiStore.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/ai-lab/run-engine src/features/ai-lab/store/useAiLabUiStore.ts
git commit -m "feat(ai-lab): add unified run lifecycle"
```

---

### Task 2: Make Electron model completions cancellable

**Files:**

- Modify: `src/features/ai-lab/lib/llmClient.ts`
- Modify: `electron/shared/channels.ts`
- Modify: `electron/main/ipc/ipc-validators.ts`
- Modify: `electron/main/handlers/ai-lab-handler.ts`
- Modify: `electron/main/preload.ts`
- Modify: `electron/types/electron-api.ts`
- Modify: `electron/main/__tests__/ai-lab-handler.test.ts`
- Modify: `electron/main/__tests__/ai-lab-handler-e2e.test.ts`
- Modify: `src/features/ai-lab/lib/__tests__/llmClient.bridge.test.ts`

**Interfaces:**

- `completeLlm(spec, { signal?, operationId? })` sends a stable operation ID.
- Complete payload adds `operationId`; cancel payload is `{ operationId }`.
- Preload adds `aiLab.cancelComplete`.

- [ ] **Step 1: Write failing renderer/main cancellation tests**

```ts
it('cancels an in-flight complete when its signal aborts', async () => {
  const controller = new AbortController();
  const pending = completeLlm(SPEC, { signal: controller.signal, operationId: OPERATION_ID });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(api.cancelComplete).toHaveBeenCalledWith({ operationId: OPERATION_ID });
});

it('refuses cancellation from another renderer', async () => {
  activeCompleteForTest(OPERATION_ID, TRUSTED.sender.id);
  const result = await handlerFor('ai-lab:complete-cancel')(OTHER_SENDER, {
    operationId: OPERATION_ID,
  });
  expect(result).toEqual({ ok: false, error: 'Operation does not belong to this renderer.' });
});
```

Add queued-cancellation and already-completed idempotency cases.

```ts
it('aborts while waiting for a completion slot', async () => {
  occupyAllCompleteSlots();
  const pending = invokeComplete(TRUSTED, { ...COMPLETE_ARGS, operationId: OPERATION_ID });
  await invokeCancel(TRUSTED, { operationId: OPERATION_ID });
  releaseOneCompleteSlot();
  await expect(pending).resolves.toEqual(expect.objectContaining({ ok: false }));
  expect(runToCompletion).not.toHaveBeenCalledWith(
    expect.objectContaining({ model: COMPLETE_ARGS.model }),
    expect.anything(),
    expect.anything()
  );
});

it('treats cancellation after completion as idempotent', async () => {
  await invokeComplete(TRUSTED, { ...COMPLETE_ARGS, operationId: OPERATION_ID });
  await expect(invokeCancel(TRUSTED, { operationId: OPERATION_ID })).resolves.toEqual({
    ok: true,
    alreadyDone: true,
  });
});
```

- [ ] **Step 2: Run the red tests outside sandbox**

Run: `npx vitest run electron/main/__tests__/ai-lab-handler.test.ts src/features/ai-lab/lib/__tests__/llmClient.bridge.test.ts`

Expected: FAIL because operation IDs and `cancelComplete` are absent.

- [ ] **Step 3: Add strict validation and sender ownership**

```ts
export const AiLabCompleteCancelSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict();

ipcMain.handle(IPC.aiLab.completeCancel, async (event, raw: unknown) => {
  assertTrustedSender(IPC.aiLab.completeCancel, event);
  const parsed = AiLabCompleteCancelSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: parsed.error.message };
  const active = activeCompletes.get(parsed.data.operationId);
  if (!active) return { ok: true as const, alreadyDone: true };
  if (active.webContentsId !== event.sender.id) {
    return { ok: false as const, error: 'Operation does not belong to this renderer.' };
  }
  activeCompletes.cancel(parsed.data.operationId);
  return { ok: true as const };
});
```

Register before semaphore acquisition, check abort immediately after acquisition, and release the semaphore exactly once.

- [ ] **Step 4: Wire renderer abort handling**

```ts
export async function completeLlm(
  spec: LlmCallSpec,
  options: { signal?: AbortSignal; operationId?: string } = {}
): Promise<CompletionResult> {
  const operationId = options.operationId ?? crypto.randomUUID();
  const cancel = () => void api().cancelComplete({ operationId });
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const res = await api().complete({ ...spec, operationId, rawMode: spec.rawMode ?? true });
    options.signal?.throwIfAborted();
    if (!res.ok) throw new Error(res.error);
    return res.result;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
```

- [ ] **Step 5: Run Electron contract tests outside sandbox**

Run: `npx vitest run electron/main/__tests__/ai-lab-handler.test.ts electron/main/__tests__/ai-lab-handler-e2e.test.ts src/features/ai-lab/lib/__tests__/llmClient.bridge.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron src/features/ai-lab/lib/llmClient.ts src/features/ai-lab/lib/__tests__/llmClient.bridge.test.ts
git commit -m "feat(ai-lab): cancel desktop model operations"
```

---

### Task 3: Propagate cancellation and normal scopes into saved-request tools

**Files:**

- Modify: `src/features/http/lib/requestExecutor.ts`
- Modify: `src/lib/shared/transport.ts`
- Modify: `electron/main/handlers/http-handler.ts`
- Modify: `src/features/ai-lab/lib/agentTools.ts`
- Modify: `src/features/ai-lab/lib/__tests__/agentTools.test.ts`
- Modify: `src/features/http/lib/__tests__/requestExecutor.test.ts`

**Interfaces:**

- `RequestExecutorOptions.signal?: AbortSignal` reaches proxy execution.
- Tool execution calls `execute(request, signal)`.
- Tool resolution uses normal environment/global/collection/auth scopes.

- [ ] **Step 1: Write failing redaction, scope, and cancellation tests**

```ts
it('redacts credentials and query values from tool descriptions', () => {
  const tool = createResturaRequestTool(
    request({ url: 'https://alice:secret@example.com/orders?token=signed&view=full#frag' }),
    vi.fn()
  );
  expect(tool.definition.description).toContain('token=REDACTED');
  expect(tool.definition.description).not.toMatch(/alice|secret|signed|full|frag/);
});

it('passes the runner signal into request execution', async () => {
  const controller = new AbortController();
  const execute = vi.fn().mockResolvedValue(response());
  const tool = createResturaRequestTool(request({ url: '{{BASE_URL}}/orders' }), execute);
  await tool.execute({}, { signal: controller.signal });
  expect(execute).toHaveBeenCalledWith(expect.anything(), controller.signal);
});
```

Add a resolver test with active environment, globals, owning collection variables, inherited auth, and collection-mutation write-back.

```ts
it('uses normal active scopes and persists successful collection mutations', async () => {
  seedGlobals({ GLOBAL_TOKEN: 'global' });
  seedActiveEnvironment({ BASE_URL: 'https://api.example.com' });
  seedCollection({ id: 'c1', variables: [{ key: 'ORDER_ID', value: '42', enabled: true }] });
  const execute = vi.fn().mockResolvedValue({
    response: response(),
    collectionVarsMutations: { ORDER_ID: '43' },
  });
  await resolveAndRunRequestTool('request-1', execute);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      envVars: expect.objectContaining({ BASE_URL: 'https://api.example.com' }),
      collectionVars: { ORDER_ID: '42' },
    })
  );
  expect(applyCollectionVarMutations).toHaveBeenCalledWith('c1', { ORDER_ID: '43' });
});
```

- [ ] **Step 2: Run the red tests**

Run: `npx vitest run src/features/ai-lab/lib/__tests__/agentTools.test.ts src/features/http/lib/__tests__/requestExecutor.test.ts`

Expected: FAIL because URLs are raw, scopes are empty, and signals are ignored.

- [ ] **Step 3: Add signal support to request execution**

```ts
export interface RequestExecutorOptions {
  request: HttpRequest;
  envVars: Record<string, string>;
  globalSettings: AppSettings;
  resolveVariables: (text: string, vars?: Record<string, string>) => string;
  signal?: AbortSignal;
  collectionVars?: Record<string, string>;
  iterationData?: Record<string, string>;
}
```

Call `signal?.throwIfAborted()` before scripts, before transport, and before mutation application. Forward the signal through renderer transport and Electron fetch.

- [ ] **Step 4: Implement safe URL descriptions**

```ts
export function redactToolUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
    return url.toString();
  } catch {
    return raw
      .replace(/\/\/[^/@\s]+@/g, '//REDACTED@')
      .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=REDACTED');
  }
}
```

- [ ] **Step 5: Reuse normal Restura request scopes**

Resolve `buildActiveRequestValueMap()`, `buildValueMap({ collection: collection.variables })`, `resolveInheritedAuthFor(request)`, effective auth/settings, and `applyCollectionVarMutations` exactly as normal Send does. Apply mutations only after success.

- [ ] **Step 6: Run focused HTTP/security tests outside sandbox**

Run: `npx vitest run src/features/ai-lab/lib/__tests__/agentTools.test.ts src/features/http/lib/__tests__/requestExecutor.test.ts tests/security`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/ai-lab/lib/agentTools.ts src/features/ai-lab/lib/__tests__/agentTools.test.ts src/features/http/lib/requestExecutor.ts src/features/http/lib/__tests__/requestExecutor.test.ts src/lib/shared/transport.ts electron/main/handlers/http-handler.ts
git commit -m "fix(ai-lab): secure saved request tools"
```

---

### Task 4: Enforce model-specific capabilities and known-only pricing

**Files:**

- Modify: `src/features/ai-lab/types.ts`
- Create: `src/features/ai-lab/lib/agentModelCapabilities.ts`
- Create: `src/features/ai-lab/lib/__tests__/agentModelCapabilities.test.ts`
- Modify: `src/features/ai-lab/lib/agentRuntime.ts`
- Modify: `src/features/ai-lab/lib/__tests__/agentRuntime.test.ts`
- Modify: `src/features/ai-lab/store/useAiLabStore.ts`
- Modify: `src/lib/shared/store-validators.ts`

**Interfaces:**

- `AiLabModelDetail.agentCapabilities?: Partial<ModelCapabilities>`.
- `AiLabProviderConfig.capabilityOverrides?: Record<string, ModelCapabilities>`.
- `capabilitiesForDesktopModel(config, model)` returns capabilities plus `assertedByUser`.
- `knownCostForCompletion(config, model, completion)` returns `number | undefined`.

- [ ] **Step 1: Write failing capability/pricing tests**

```ts
it('defaults unknown models to text-only without tools', () => {
  expect(
    capabilitiesForDesktopModel(config({ models: ['custom'] }), 'custom').capabilities
  ).toMatchObject({ inputModalities: ['text'], toolCalling: false, structuredOutput: false });
});

it('marks explicit capability overrides as user asserted', () => {
  const result = capabilitiesForDesktopModel(
    config({
      capabilityOverrides: { custom: { ...CONSERVATIVE, toolCalling: true } },
    }),
    'custom'
  );
  expect(result.assertedByUser).toBe(true);
  expect(result.capabilities.toolCalling).toBe(true);
});

it('omits cost when pricing is unknown', async () => {
  const response = await generateWith(config({ pricingKnown: false }), usage(0));
  expect(response.costUSD).toBeUndefined();
});
```

- [ ] **Step 2: Run the red tests**

Run: `npx vitest run src/features/ai-lab/lib/__tests__/agentModelCapabilities.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts`

Expected: FAIL because static provider profiles and unconditional cost are used.

- [ ] **Step 3: Implement conservative capability resolution**

```ts
export const CONSERVATIVE_DESKTOP_CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: false,
  parallelToolCalls: false,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

export function capabilitiesForDesktopModel(config: AiLabProviderConfig, model: string) {
  const override = config.capabilityOverrides?.[model];
  if (override) return { capabilities: override, assertedByUser: true };
  const discovered = config.modelDetails?.[model]?.agentCapabilities;
  return {
    capabilities: { ...CONSERVATIVE_DESKTOP_CAPABILITIES, ...discovered },
    assertedByUser: false,
  };
}
```

Only tested discovery metadata or explicit overrides may enable tools/modalities.

- [ ] **Step 4: Emit cost only for exact known pricing**

Use discovered prompt/completion prices with returned usage. Return undefined for arbitrary gateways and unknown models. Classify local zero cost explicitly rather than from missing pricing.

- [ ] **Step 5: Run adapter/store tests**

Run: `npx vitest run src/features/ai-lab/lib/__tests__/agentModelCapabilities.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts src/features/ai-lab/store/__tests__`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/ai-lab/types.ts src/features/ai-lab/lib/agentModelCapabilities.ts src/features/ai-lab/lib/__tests__/agentModelCapabilities.test.ts src/features/ai-lab/lib/agentRuntime.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts src/features/ai-lab/store src/lib/shared/store-validators.ts
git commit -m "fix(ai-lab): negotiate model capabilities honestly"
```

---

### Task 5: Make token budgets run-wide and fail closed

**Files:**

- Modify: `shared/agent-lab/runner.ts`
- Modify: `shared/agent-lab/schema.ts`
- Modify: `shared/agent-lab/__tests__/runner.test.ts`
- Modify: `shared/agent-lab/__tests__/schema.test.ts`

**Interfaces:**

- `limits.maxTokens` remains backward-compatible but is enforced as total run tokens.
- Each generation receives the remaining allowance.
- Missing usage fails when a token budget is configured.

- [ ] **Step 1: Write failing multi-turn token tests**

```ts
it('passes only remaining tokens to later turns', async () => {
  const requests: GenerationRequest[] = [];
  const configured = suiteWithLimit({ maxTokens: 100 });
  await runResponses(configured, requests, [
    response({ usage: { inputTokens: 30, outputTokens: 20 }, toolCall: true }),
    response({ usage: { inputTokens: 10, outputTokens: 10 } }),
  ]);
  expect(requests.map((request) => request.maxOutputTokens)).toEqual([100, 50]);
});

it('fails before tools after token overshoot', async () => {
  const result = await runResponse(
    response({ usage: { inputTokens: 90, outputTokens: 20 }, toolCall: true }),
    { maxTokens: 100 }
  );
  expect(result.error).toContain('exceeded maxTokens (100)');
  expect(result.trace.events.some((event) => event.type === 'tool.requested')).toBe(false);
});

it('fails closed when usage is absent under a token budget', async () => {
  const result = await runResponse(response({ usage: undefined }), { maxTokens: 100 });
  expect(result.error).toContain('provider usage is unknown');
});
```

- [ ] **Step 2: Run the red tests**

Run: `npx vitest run shared/agent-lab/__tests__/runner.test.ts shared/agent-lab/__tests__/schema.test.ts`

Expected: FAIL because the original limit is sent every turn and missing usage passes.

- [ ] **Step 3: Implement remaining-budget enforcement**

```ts
const remainingTokens =
  agent.limits.maxTokens === undefined ? undefined : agent.limits.maxTokens - totalTokens;
if (remainingTokens !== undefined && remainingTokens <= 0) {
  throw new Error(`agent exceeded maxTokens (${agent.limits.maxTokens})`);
}
```

Set `maxOutputTokens` to `remainingTokens`. After response, reject absent usage and overshoot before executing returned tools.

- [ ] **Step 4: Run runner tests**

Run: `npx vitest run shared/agent-lab/__tests__/runner.test.ts shared/agent-lab/__tests__/provider.test.ts shared/agent-lab/__tests__/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/agent-lab/runner.ts shared/agent-lab/schema.ts shared/agent-lab/__tests__/runner.test.ts shared/agent-lab/__tests__/schema.test.ts
git commit -m "fix(ai-lab): enforce total token budgets"
```

---

### Task 6: Add task-aware grading, judge isolation, and calibration validation

**Files:**

- Modify: `shared/agent-lab/types.ts`
- Modify: `shared/agent-lab/schema.ts`
- Modify: `shared/agent-lab/suite-runner.ts`
- Modify: `shared/agent-lab/__tests__/schema.test.ts`
- Modify: `shared/agent-lab/__tests__/suite-runner.test.ts`
- Modify: `src/features/ai-lab/lib/agentRuntime.ts`
- Modify: `src/features/ai-lab/lib/__tests__/agentRuntime.test.ts`

**Interfaces:**

- `AgentGradingContext` contains task, result, input text, reference, and output text.
- Judge grader adds optional `minimumQuorum`; default is strict majority.
- Judge results retain successful votes and per-model failures.

- [ ] **Step 1: Write failing task-reference and panel tests**

```ts
it('grades each task against its own reference', async () => {
  const report = await runSuite(
    suiteWithReferences([
      { id: 'a', input: 'A', reference: 'alpha' },
      { id: 'b', input: 'B', reference: 'beta' },
    ]),
    ['alpha', 'beta']
  );
  expect(report.results.flatMap((result) => result.grades).every((grade) => grade.passed)).toBe(
    true
  );
});

it('retains successful votes when one judge fails', async () => {
  const grade = await runJudgePanel([passVote(), failVote('timeout'), passVote()], 2);
  expect(grade.passed).toBe(true);
  expect(grade.detail).toContain('2/3 judges succeeded');
  expect(grade.judgeFailures).toEqual([{ providerId: 'judge-2', error: 'timeout' }]);
});
```

- [ ] **Step 2: Write failing calibration-schema tests**

```ts
it.each([
  ['unknown passing label', judge({ labels: ['pass', 'fail'], passingLabels: ['maybe'] })],
  ['single-class anchors', judge({ calibrated: true, anchors: [passAnchor(0.9), passAnchor(1)] })],
  ['narrow score span', judge({ calibrated: true, anchors: [passAnchor(0.8), failAnchor(0.4)] })],
  ['duplicate model', judge({ judgeModels: [MODEL, MODEL] })],
])('rejects %s', (_name, grader) => {
  expect(() => AgentSuiteSchema.parse(suiteWithGrader(grader))).toThrow();
});
```

- [ ] **Step 3: Run the red tests**

Run: `npx vitest run shared/agent-lab/__tests__/schema.test.ts shared/agent-lab/__tests__/suite-runner.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts`

Expected: FAIL because references are unused, panel rejection is all-or-nothing, and semantic validation is absent.

- [ ] **Step 4: Carry grading context**

```ts
export interface AgentGradingContext {
  task: AgentTask;
  result: AgentRunResult;
  inputText: string;
  reference?: string;
  outputText: string;
}
```

Construct one context per task/trial. Reference-aware graders use `context.reference`; literal graders keep configured values. Judge prompts include input, reference, output, rubric, labels, and response schema.

- [ ] **Step 5: Isolate judges and require quorum**

```ts
const settled = await Promise.allSettled(
  grader.judgeModels.map((model) => invokeJudge(model, context))
);
const votes = settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
const failures = settled.flatMap((entry, index) =>
  entry.status === 'rejected'
    ? [{ model: grader.judgeModels[index]!, error: errorMessage(entry.reason) }]
    : []
);
const quorum = grader.minimumQuorum ?? Math.floor(grader.judgeModels.length / 2) + 1;
```

Return an explicit failed grader when `votes.length < quorum`; do not throw away other grader results.

- [ ] **Step 6: Add calibration semantic rules**

In `AgentSuiteSchema.superRefine`, require label membership, unique judge models, valid quorum, passing/non-passing anchor coverage, and score span at least `0.5` for calibrated judges.

- [ ] **Step 7: Run grading tests**

Run: `npx vitest run shared/agent-lab/__tests__/evaluation.test.ts shared/agent-lab/__tests__/schema.test.ts shared/agent-lab/__tests__/suite-runner.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add shared/agent-lab src/features/ai-lab/lib/agentRuntime.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts
git commit -m "fix(ai-lab): make agent grading task aware"
```

---

### Task 7: Integrate both executors and persist full reports

**Files:**

- Create: `src/features/ai-lab/run-engine/reportEnvelope.ts`
- Create: `src/features/ai-lab/run-engine/__tests__/reportEnvelope.test.ts`
- Modify: `src/features/ai-lab/hooks/useEvalRun.ts`
- Modify: `src/features/ai-lab/lib/agentRuntime.ts`
- Modify: `src/features/ai-lab/components/AgentWorkbench.tsx`
- Modify: `src/features/ai-lab/components/ReportView.tsx`
- Create: `src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx`
- Modify: `src/features/ai-lab/store/useAiLabStore.ts`
- Modify: `src/features/ai-lab/store/useAiLabUiStore.ts`
- Modify: `src/lib/shared/store-validators.ts`

**Interfaces:**

- `AiLabReportEnvelope` discriminates `eval` and `agent-suite` payloads.
- Store adds `runReports`, `saveRunReport`, and `removeRunReport` additively.
- `runDesktopAgentSuite` accepts and forwards `signal`.

- [ ] **Step 1: Write failing persistence/Cancel tests**

```tsx
it('cancels the active job and rejects late success', async () => {
  render(<AgentWorkbench />);
  await user.click(screen.getByRole('button', { name: 'Run' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancelJob).toHaveBeenCalled();
  expect(await screen.findByRole('status')).toHaveTextContent('CANCELLED');
  expect(saveRunReport).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'passed' }));
});

it('persists the agent report and opens Reports', async () => {
  completeAgentRun(REPORT);
  expect(saveRunReport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent-suite' }));
  expect(openReport).toHaveBeenCalledWith(REPORT.id);
});
```

Add migration coverage proving old eval runs remain readable and `runReports` defaults to `{}`.

```ts
it('migrates legacy eval state without rewriting existing runs', () => {
  const migrated = migrateAiLabState({ ...LEGACY_STATE, runs: { legacy: LEGACY_RUN } }, 2);
  expect(migrated.runs).toEqual({ legacy: LEGACY_RUN });
  expect(migrated.runReports).toEqual({});
});
```

- [ ] **Step 2: Run the red tests**

Run: `npx vitest run src/features/ai-lab/run-engine src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/store/__tests__`

Expected: FAIL because unified reports and Cancel UI are absent.

- [ ] **Step 3: Add additive report envelopes**

```ts
export type AiLabReportEnvelope =
  | {
      id: string;
      kind: 'eval';
      name: string;
      startedAt: number;
      finishedAt: number;
      status: string;
      payload: EvalRun;
    }
  | {
      id: string;
      kind: 'agent-suite';
      name: string;
      startedAt: number;
      finishedAt: number;
      status: string;
      payload: AgentSuiteReport;
    };
```

Adapt existing eval records on read; never rewrite them destructively.

- [ ] **Step 4: Use RunEngine in both launch paths**

Wrap `useEvalRun` and `AgentWorkbench` with the shared engine. Pass `context.signal` through retries, `completeLlm`, suite trials, judges, and tools. Map existing case/model and task/trial progress into `reportProgress`.

- [ ] **Step 5: Render agent reports in Reports**

Branch on envelope kind. Render summary/confidence, reliability per task, input/reference, grader detail, judge failures/quorum, traces, usage/cost, and JSON export. Preserve current eval rendering.

- [ ] **Step 6: Run UI/store tests**

Run: `npx vitest run src/features/ai-lab/run-engine src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/components/__tests__/ReportView.test.tsx src/features/ai-lab/store/__tests__ src/features/ai-lab/lib/__tests__/evalRunner.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/ai-lab/run-engine src/features/ai-lab/hooks/useEvalRun.ts src/features/ai-lab/lib/agentRuntime.ts src/features/ai-lab/components/AgentWorkbench.tsx src/features/ai-lab/components/ReportView.tsx src/features/ai-lab/components/__tests__ src/features/ai-lab/store src/lib/shared/store-validators.ts
git commit -m "feat(ai-lab): unify run cancellation and reports"
```

---

### Task 8: Add direct CLI agent-eval coverage

**Files:**

- Modify: `cli/src/commands/agent.ts`
- Create: `cli/src/commands/__tests__/agent.test.ts`

**Interfaces:**

- `preflightAgentSuite(suite)` performs unsupported-feature rejection without I/O.
- `agentEvalExitCode(reportOrError)` returns `0 | 1 | 2`.
- `evaluateAgentSuite` accepts injected read/write/fetch/environment dependencies.

- [ ] **Step 1: Write failing non-listening CLI tests**

```ts
it.each([
  ['provider', suite({ providerId: 'anthropic' }), /adapter not registered/],
  ['base URL', suite({ baseUrl: 'https://gateway.example' }), /baseUrl overrides/],
  ['tool', suite({ tools: [{ kind: 'restura-request', requestId: 'r1' }] }), /tool adapter/],
  ['judge', suite({ graders: [judgeGrader()] }), /judge adapter/],
  [
    'secret handle',
    suite({ credential: { source: 'secret-handle', handleId: 'h1' } }),
    /desktop keychain/,
  ],
])('rejects unsupported %s before fetch', async (_name, input, pattern) => {
  await expect(evaluateFixture(input)).rejects.toThrow(pattern);
  expect(fetcher).not.toHaveBeenCalled();
});

it('writes reports and maps exit codes', async () => {
  await evaluateFixture(validSuite(), { output: '/report.json' });
  expect(writeText).toHaveBeenCalledWith('/report.json', expect.stringContaining('"summary"'));
  expect(agentEvalExitCode(passedReport())).toBe(0);
  expect(agentEvalExitCode(failedReport())).toBe(1);
  expect(agentEvalExitCode(new Error('invalid'))).toBe(2);
});
```

- [ ] **Step 2: Run the red test**

Run: `npx vitest run cli/src/commands/__tests__/agent.test.ts`

Expected: FAIL because testable preflight, exit mapping, and dependency injection are absent.

- [ ] **Step 3: Extract pure preflight and exit mapping**

Move the current provider/base URL/tool/judge checks into `preflightAgentSuite`. Add an explicit credential-source walk. Implement:

```ts
export function agentEvalExitCode(value: AgentSuiteReport | Error): 0 | 1 | 2 {
  if (value instanceof Error) return 2;
  return value.status === 'passed' ? 0 : 1;
}
```

Inject filesystem, fetcher, and environment readers with production defaults.

- [ ] **Step 4: Run CLI tests/type-check**

Run: `npx vitest run cli/src/commands/__tests__/agent.test.ts && npm --prefix cli run type-check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/agent.ts cli/src/commands/__tests__/agent.test.ts
git commit -m "test(cli): cover agent eval command"
```

---

### Task 9: Align documentation and capability claims

**Files:**

- Modify: `docs/adr/0020-ai-lab-eval-workbench.md`
- Modify: `src/lib/shared/capabilities.ts`
- Generate: `docs/CAPABILITY_MATRIX.md`
- Modify: `openwiki/features/ai-mcp.md`
- Modify: `docs/cli/README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Capability documentation remains generated from `capabilities.ts`.

- [ ] **Step 1: Extend capability assertions**

Assert agent suites remain Electron-only, MCP/sandbox remain disabled, and cancellation/report persistence wording matches shipped behavior.

- [ ] **Step 2: Correct ADR/support wording**

Use: “stateless encrypted reasoning and function-call replay using `store: false`; server-side `previous_response_id` continuation is disabled.” Document conservative per-model negotiation, hard cancellation, task references, judge quorum, run-wide budgets, report persistence, CLI limitations, and user-asserted capability overrides.

- [ ] **Step 3: Regenerate and verify docs**

Run: `npm run capabilities:matrix && npm run capabilities:check && npx prettier --write docs/adr/0020-ai-lab-eval-workbench.md openwiki/features/ai-mcp.md docs/cli/README.md AGENTS.md CLAUDE.md`

Expected: matrix check and formatting pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/capabilities.ts docs/CAPABILITY_MATRIX.md docs/adr/0020-ai-lab-eval-workbench.md openwiki/features/ai-mcp.md docs/cli/README.md AGENTS.md CLAUDE.md
git commit -m "docs(ai-lab): document unified run guarantees"
```

---

### Task 10: Verify, smoke-test, review, and update PR #480

**Files:**

- Modify only files required by valid verification or review findings.

**Interfaces:**

- Exit criterion: full validation and packaging pass; no Critical or Important fresh-review findings remain.

- [ ] **Step 1: Run focused suites outside sandbox**

Run: `npx vitest run shared/agent-lab src/features/ai-lab electron/main/__tests__/ai-lab-handler.test.ts electron/main/__tests__/ai-lab-handler-e2e.test.ts src/features/http/lib/__tests__/requestExecutor.test.ts tests/security`

Expected: PASS.

- [ ] **Step 2: Run the CI-equivalent gate outside sandbox**

Run: `npm run validate`

Expected: all type checks, lint, formatting, codegen, capability checks, application tests, and CLI tests pass.

- [ ] **Step 3: Run packaging checks**

```bash
npm run build
npm run electron:compile
npm --prefix cli run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Run live UI smoke when browser control is available**

Start `npm run dev`, open AI Lab, run and cancel a deterministic suite, verify Reports navigation and console cleanliness. If no browser runtime is connected, record that limitation without substituting another browser tool.

- [ ] **Step 5: Request a fresh read-only review**

Provide only base SHA, head SHA, approved design, and full diff. Require security, cancellation, budgets, provider wires, grading, persistence, CLI, docs, and parity review. Fix every valid Critical or Important item test-first and repeat Steps 1–3.

- [ ] **Step 6: Push and verify PR #480**

```bash
git push origin agent/ai-lab-workbench
gh pr view 480 --json url,title,isDraft,state,baseRefName,headRefName,headRefOid
```

Expected: PR #480 is open as a draft against `main`, and `headRefOid` equals local HEAD.
