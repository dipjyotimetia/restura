# Kafka Client UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the desktop Kafka client into a clear producer, consumer, message-inspection, and administration workflow without changing native Kafka behavior or IPC contracts.

**Architecture:** `KafkaClient` remains the connection-level orchestrator while each tab owns its task-specific ephemeral state and controls. The work changes React presentation and component tests only, with the existing Zustand connection schema, manager, Electron IPC validators, and `@platformatic/kafka` runtime left intact.

**Tech Stack:** React 19, TypeScript, Zustand, Radix-based Restura UI primitives, Tailwind CSS 4, Vitest, React Testing Library, Playwright Electron, Redpanda.

## Global Constraints

- Kafka remains desktop-only.
- Do not change Kafka IPC contracts, persisted connection schemas, native dependency behavior, or SSRF/secret-storage boundaries.
- Preserve single, batch, stream, transaction, consumer, manual-commit, and advanced-admin behavior.
- Use existing semantic `sp-*` design tokens and component primitives.
- All interactive controls require visible labels or accessible names.
- State must use text plus icon/badge rather than color alone.
- Two-column forms must collapse to one column at narrow widths.
- Production code changes must follow a witnessed RED-GREEN-REFACTOR cycle.

---

### Task 1: Connection shell and consumer-owned controls

**Files:**
- Create: `src/features/kafka/components/__tests__/KafkaClient.test.tsx`
- Modify: `src/features/kafka/components/__tests__/KafkaConsumerPanel.test.tsx`
- Modify: `src/features/kafka/components/KafkaClient.tsx`
- Modify: `src/features/kafka/components/KafkaConsumerPanel.tsx`

**Interfaces:**
- Consumes: existing `KafkaConnection`, `KafkaConsumerState`, `ConsumeMode`, and callback props.
- Produces: `KafkaClient` header containing connection state only; `KafkaConsumerPanel` containing start position, subscription badge, stream badge, and performance disclosure.

- [ ] **Step 1: Write failing shell and consumer tests**

Add a direct named export for the unwrapped client only when the production step begins. In the test, mock `useKafkaConnection` with a connected Kafka connection, render `<KafkaClient />`, and assert:

```tsx
expect(screen.getByText('Connected')).toBeVisible();
expect(screen.queryByLabelText('Consume start position')).not.toBeInTheDocument();
expect(screen.queryByRole('button', { name: /freeze/i })).not.toBeInTheDocument();
```

Extend `KafkaConsumerPanel.test.tsx`:

```tsx
expect(screen.getByLabelText('Consume start position')).toHaveValue('latest');
expect(screen.getByText('Subscription: Idle')).toBeVisible();
expect(screen.getByText('Stream: Running')).toBeVisible();
expect(screen.queryByLabelText('Session timeout (ms)')).not.toBeVisible();

await user.click(screen.getByText('Performance tuning'));
expect(screen.getByLabelText('Session timeout (ms)')).toHaveAttribute(
  'placeholder',
  'Client default'
);
expect(screen.getByText(/Blank values use the native Kafka client defaults/)).toBeVisible();
```

Add a subscribed/paused fixture assertion proving the visible primary stream action is `Resume consumer` and the duplicate raw `subscribed` badge is absent.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run src/features/kafka/components/__tests__/KafkaClient.test.tsx src/features/kafka/components/__tests__/KafkaConsumerPanel.test.tsx
```

Expected: failures because connection-only status, select-based start position, state labels, and tuning disclosure do not yet exist.

- [ ] **Step 3: Implement the connection-only shell**

In `KafkaClient.tsx`:

- export the unwrapped `KafkaClient` for testing while retaining the wrapped default export;
- remove `Segmented`, `Pause`, and `Play` from the shared header;
- render a connection badge based on `connection.status`;
- pass `paused` and `setPaused` only to `KafkaMessagesPanel`;
- keep subscribe/pause dispatch functions unchanged.

The header status mapping must be:

```tsx
const connectionBadge =
  connection.status === 'connected'
    ? { label: 'Connected', tone: 'success' as const }
    : connection.status === 'connecting'
      ? { label: 'Connecting', tone: 'warning' as const }
      : connection.status === 'error'
        ? { label: 'Connection error', tone: 'danger' as const }
        : { label: 'Disconnected', tone: 'neutral' as const };
```

- [ ] **Step 4: Reorganize `KafkaConsumerPanel`**

Replace the segmented start-mode strip with:

```tsx
<Label htmlFor="kafka-consume-start-position">Start position</Label>
<select
  id="kafka-consume-start-position"
  aria-label="Consume start position"
  value={consumeMode}
  onChange={(event) => onConsumeModeChange(event.target.value as ConsumeMode)}
>
  <option value="committed">Committed offset</option>
  <option value="latest">Latest messages</option>
  <option value="earliest">Earliest messages</option>
  <option value="from-offset">Specific offset</option>
  <option value="from-timestamp">Timestamp</option>
</select>
```

Keep commit policy, isolation, group protocol, and committed fallback in a visible
`Delivery` section. Move static membership, remote assignor, timeout, fetch, and
high-water fields into a closed `Performance tuning` details element.

Each numeric input uses a unique ID, accessible label containing its unit, and
`placeholder="Client default"`. Use `grid-cols-1 md:grid-cols-2`. Add the exact
helper text “Blank values use the native Kafka client defaults.”

Render `Subscription: <state>` and `Stream: Running|Paused` badges near controls.
Show Subscribe while idle, Unsubscribe while subscribed, and exactly one
Pause/Resume stream button while subscribed.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 Vitest command. Expected: both files pass with no React warnings.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/features/kafka/components/KafkaClient.tsx src/features/kafka/components/KafkaConsumerPanel.tsx src/features/kafka/components/__tests__/KafkaClient.test.tsx src/features/kafka/components/__tests__/KafkaConsumerPanel.test.tsx
git commit -m "refactor(kafka): clarify consumer runtime controls"
```

---

### Task 2: Message activity and record inspection

**Files:**
- Create: `src/features/kafka/components/__tests__/KafkaMessagesPanel.test.tsx`
- Modify: `src/features/kafka/components/KafkaMessagesPanel.tsx`

**Interfaces:**
- Consumes: `KafkaConnection.messages`, where `direction === 'system'` identifies local lifecycle activity.
- Produces: a Messages-owned Live/Frozen toggle and semantically distinct activity/record rows.

- [ ] **Step 1: Write failing message-workspace tests**

Render a connection containing one `system` message and one `received` record:

```tsx
const messages = [
  {
    id: 'activity-1',
    direction: 'system',
    topic: '',
    value: 'Subscribed to orders',
    timestamp: 1,
  },
  {
    id: 'record-1',
    direction: 'received',
    topic: 'orders',
    partition: 0,
    offset: '42',
    value: '',
    tombstone: true,
    timestamp: 2,
  },
] satisfies KafkaMessage[];
```

Assert:

```tsx
expect(screen.getByRole('button', { name: 'Freeze message view' })).toBeVisible();
expect(screen.getByText('Activity')).toBeVisible();
expect(screen.getByText('Subscribed to orders')).toBeVisible();
expect(screen.getByText('Tombstone')).toBeVisible();
expect(screen.getByText(/Kafka null value/)).toBeVisible();
```

Click the freeze control and assert the accessible name becomes `Resume live message view`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/features/kafka/components/__tests__/KafkaMessagesPanel.test.tsx
```

Expected: failures because the panel does not own the view toggle and system rows are not typed as activity.

- [ ] **Step 3: Implement activity/record presentation**

Change the panel props to:

```ts
interface KafkaMessagesPanelProps {
  connection: KafkaConnection;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
}
```

Add the Live/Frozen button to the message toolbar. Its accessible name is
`Freeze message view` while live and `Resume live message view` while frozen.

For `direction === 'system'`, render an activity icon, a visible `Activity`
badge, message text, and time. Do not render fake partition/offset cells; use
appropriately spanned cells or an explicit row type cell.

For records, retain current columns and selection. In the inspector, when
`tombstone === true`, render a `Tombstone` badge plus:

```tsx
<p>Kafka null value. Consumers may interpret this as a delete marker.</p>
```

Keep Base64 headers, manual commit, key/value content, filtering, and lag metrics unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 2 Vitest command. Expected: pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/features/kafka/components/KafkaMessagesPanel.tsx src/features/kafka/components/__tests__/KafkaMessagesPanel.test.tsx
git commit -m "refactor(kafka): distinguish activity from records"
```

---

### Task 3: Explicit producer workflow modes

**Files:**
- Modify: `src/features/kafka/components/__tests__/KafkaProducerPanel.test.tsx`
- Modify: `src/features/kafka/components/KafkaProducerPanel.tsx`

**Interfaces:**
- Consumes: existing producer callbacks and Electron stream/transaction methods.
- Produces: local `ProducerMode = 'single' | 'batch' | 'stream' | 'transaction'` navigation with unchanged native calls.

- [ ] **Step 1: Rewrite producer tests for explicit modes**

Replace accordion-opening steps with mode navigation:

```tsx
expect(screen.getByRole('tab', { name: 'Single record' })).toHaveAttribute(
  'aria-selected',
  'true'
);
await user.click(screen.getByRole('tab', { name: 'Batch' }));
expect(screen.getByLabelText('Kafka typed record batch')).toBeVisible();
await user.click(screen.getByRole('tab', { name: 'Stream' }));
expect(screen.getByRole('button', { name: 'Open stream' })).toBeVisible();
await user.click(screen.getByRole('tab', { name: 'Transaction' }));
expect(screen.getByRole('button', { name: 'Begin transaction' })).toBeVisible();
```

In the tombstone test assert:

```tsx
expect(screen.getByLabelText('Kafka message value')).toBeDisabled();
expect(screen.getByText(/Kafka receives a null value/)).toBeVisible();
```

Keep the serialized-operation and full stream/transaction sequence assertions,
switching modes before each workflow.

- [ ] **Step 2: Run the producer test and verify RED**

Run:

```bash
npx vitest run src/features/kafka/components/__tests__/KafkaProducerPanel.test.tsx
```

Expected: failure because producer modes do not exist.

- [ ] **Step 3: Implement producer modes**

Add local mode state:

```ts
type ProducerMode = 'single' | 'batch' | 'stream' | 'transaction';
const [mode, setMode] = useState<ProducerMode>('single');
```

Render a compact accessible tablist using the existing `Tabs`, `TabsList`,
`TabsTrigger`, and `TabsContent` primitives. Move existing controls without
rewriting their native request handlers:

- single: key, headers, partition, value, tombstone, Publish;
- batch: batch JSON and Publish batch;
- stream: stream batch JSON, batching/backpressure inputs, Open/Write/Close;
- transaction: transaction status, Begin, Send, Commit, Abort.

Use `grid-cols-1 md:grid-cols-2` for paired fields. Place encoding selects beside
Key and Value labels. Tombstone disables the value editor and renders “Kafka
receives a null value; compacted topics commonly treat this as a delete marker.”

Keep `sessionBusy`, stream/transaction mutual exclusion, and error handling unchanged.

- [ ] **Step 4: Run the producer test and verify GREEN**

Run the Task 3 Vitest command. Expected: pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/features/kafka/components/KafkaProducerPanel.tsx src/features/kafka/components/__tests__/KafkaProducerPanel.test.tsx
git commit -m "refactor(kafka): expose producer workflow modes"
```

---

### Task 4: Searchable administration and announced advanced results

**Files:**
- Create: `src/features/kafka/components/__tests__/KafkaAdminPanel.test.tsx`
- Modify: `src/features/kafka/components/__tests__/KafkaAdvancedAdmin.test.tsx`
- Modify: `src/features/kafka/components/KafkaAdminPanel.tsx`
- Modify: `src/features/kafka/components/KafkaAdvancedAdmin.tsx`

**Interfaces:**
- Consumes: existing topic/group admin methods and typed confirmation behavior.
- Produces: local topic filter/count state and `{ label: string; value: unknown } | null` advanced-operation feedback.

- [ ] **Step 1: Write failing admin tests**

Mock `kafkaManager.listTopics` to return `['orders', 'payments', 'audit']`.
Render the Admin tab, click `List topics`, and assert:

```tsx
expect(await screen.findByText('3 topics')).toBeVisible();
await user.type(screen.getByRole('searchbox', { name: 'Filter topics' }), 'pay');
expect(screen.getByText('payments')).toBeVisible();
expect(screen.queryByText('orders')).not.toBeInTheDocument();
expect(screen.getByText('1 of 3 topics')).toBeVisible();
await user.clear(screen.getByRole('searchbox', { name: 'Filter topics' }));
await user.type(screen.getByRole('searchbox', { name: 'Filter topics' }), 'missing');
expect(screen.getByText('No topics match “missing”.')).toBeVisible();
```

Assert inspect/delete controls retain accessible topic-specific names and Delete
uses destructive styling.

Extend the advanced test:

```tsx
const result = await screen.findByRole('status');
expect(result).toHaveTextContent('Describe cluster result');
expect(result).toHaveAttribute('aria-live', 'polite');
```

Add a malformed ACL JSON test that clicks Describe ACLs and expects an
operation error result instead of a rejected event-handler exception.

- [ ] **Step 2: Run admin tests and verify RED**

Run:

```bash
npx vitest run src/features/kafka/components/__tests__/KafkaAdminPanel.test.tsx src/features/kafka/components/__tests__/KafkaAdvancedAdmin.test.tsx
```

Expected: failures because filtering/counts, labelled live results, and guarded ACL parsing do not exist.

- [ ] **Step 3: Implement topic discovery UX**

Add:

```ts
const [topicFilter, setTopicFilter] = useState('');
const filteredTopics =
  topics?.filter((topic) => topic.toLowerCase().includes(topicFilter.trim().toLowerCase())) ?? [];
```

When topics are loaded, render a `type="search"` input labelled `Filter topics`,
the total/filtered count, and a two-column visual header (`Topic`, `Actions`).
Use meaningful unloaded, empty, and no-match text. Preserve inline inspection
and confirmation dialog deletion. Give Delete the existing destructive variant
while keeping the exact `Delete topic <name>` accessible name.

Use responsive create-topic layout with explicit labels for Name, Partitions,
and Replication factor rather than relying on the “name · partitions · replication” hint.

- [ ] **Step 4: Implement labelled advanced results**

Replace raw result state with:

```ts
interface OperationResult {
  label: string;
  value: unknown;
}
const [result, setResult] = useState<OperationResult | null>(null);
const run = async (label: string, operation: () => Promise<unknown>) => {
  try {
    setResult({ label, value: await operation() });
  } catch (error) {
    setResult({
      label,
      value: { success: false, error: error instanceof Error ? error.message : String(error) },
    });
  }
};
```

Render the result in `role="status" aria-live="polite"` with heading
`<label> result`. Call `run` with operation-specific labels such as
`Describe cluster`, `Validate partitions`, and `Delete matching ACLs`.
Parse ACL JSON inside the `run` callback so syntax errors are displayed.

- [ ] **Step 5: Run admin tests and verify GREEN**

Run the Task 4 Vitest command. Expected: pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/features/kafka/components/KafkaAdminPanel.tsx src/features/kafka/components/KafkaAdvancedAdmin.tsx src/features/kafka/components/__tests__/KafkaAdminPanel.test.tsx src/features/kafka/components/__tests__/KafkaAdvancedAdmin.test.tsx
git commit -m "refactor(kafka): improve administration discovery"
```

---

### Task 5: Electron E2E interaction and visual assertions

**Files:**
- Modify: `e2e-electron/specs/kafka.spec.ts`
- Modify: `e2e-electron/specs/desktop-only.spec.ts` only if accessible menu naming changes.

**Interfaces:**
- Consumes: the updated accessible names from Tasks 1–4.
- Produces: live Redpanda coverage for relocated controls and explicit producer modes.

- [ ] **Step 1: Update E2E expectations before rebuilding**

Update Kafka E2E interactions to:

- choose start position through `getByLabel('Consume start position')`;
- click `Pause consumer` and `Resume consumer` in Consume;
- freeze/unfreeze through the Messages toolbar;
- select Batch, Stream, and Transaction producer tabs before their controls;
- filter the Admin topic list and clear the search before inspecting/deleting.

Add visible assertions:

```ts
await expect(page.getByText('Connection: Connected')).toBeVisible();
await expect(page.getByText('Subscription: Subscribed')).toBeVisible();
await expect(page.getByRole('button', { name: 'Freeze message view' })).toBeVisible();
await expect(page.getByText('Activity').first()).toBeVisible();
```

- [ ] **Step 2: Run static E2E lint/type coverage**

Run:

```bash
npm run format:check
npm run type-check:all
```

Expected: pass after any selector/type corrections.

- [ ] **Step 3: Build and run live Electron tests**

Run:

```bash
npm run test:e2e:electron:build
npm run test:e2e:electron -- e2e-electron/specs/kafka.spec.ts
npm run test:e2e:electron -- e2e-electron/specs/desktop-only.spec.ts
```

Expected: Kafka spec passes against pinned local Redpanda; desktop-only navigation passes.

- [ ] **Step 4: Commit Task 5**

```bash
git add e2e-electron/specs/kafka.spec.ts e2e-electron/specs/desktop-only.spec.ts
git commit -m "test(kafka): verify refined desktop workflows"
```

---

### Task 6: Full verification, visual review, and PR delivery

**Files:**
- Modify only files required by failures discovered in this task, always with a reproducing regression first.

**Interfaces:**
- Consumes: all Task 1–5 deliverables.
- Produces: a clean, pushed branch and updated draft PR with local and hosted evidence.

- [ ] **Step 1: Run the complete Kafka component slice**

Run:

```bash
npx vitest run src/features/kafka electron/main/__tests__/kafka-handler.test.ts electron/main/__tests__/kafka-validators.test.ts tests/security/secret-storage-routing.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run repository policy and coverage gates**

Run:

```bash
npm run architecture:check
npm run type-check:all
npm run lint
npm run format:check
npm run test:ci
npm run test:workspaces
npm run validate:build
```

Expected: all exit zero and merged coverage thresholds pass.

- [ ] **Step 3: Perform built Electron visual review**

At normal desktop width and a narrow renderer width, inspect:

- Connection header wrapping and state;
- Produce modes and disabled tombstone editor;
- Consume hierarchy, tuning disclosure, and runtime badges;
- Messages activity/record distinction and Live/Frozen control;
- Admin counts, filtering, no-match state, destructive affordance, and advanced result.

Capture screenshots, inspect the accessibility tree/focus order, and confirm the
renderer console contains zero new errors or warnings.

- [ ] **Step 4: Run final diff hygiene**

Run:

```bash
git diff --check
git status --short
git diff main...HEAD -- package-lock.json shared/opencollection/spec-types.ts
```

Expected: no whitespace errors, only intended files, and no lock/generated-type drift.

- [ ] **Step 5: Commit any verification-driven fixes**

If Step 2 or 3 found an issue, first add a failing regression, implement the
minimal fix, rerun the affected gate, then:

```bash
git add <affected-files>
git commit -m "fix(kafka): address UI verification findings"
```

If no fixes were required, do not create an empty commit.

- [ ] **Step 6: Push and update draft PR**

```bash
git push
gh pr view 594 --json url,isDraft,statusCheckRollup
gh pr checks 594 --watch --interval 10
```

Keep the worktree for PR feedback. Report local results separately from hosted
checks and do not call the PR merge-ready until required CI, E2E, integration,
and packaging checks are green.
