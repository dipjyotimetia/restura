# Kafka Client UI Refinement Design

**Date:** 2026-07-29  
**Status:** Approved interaction direction; implementation pending

## Objective

Make the desktop Kafka client easier to understand without reducing its native
producer, consumer, message-inspection, or administration capabilities.

The redesign must:

- stop consumer controls from making unrelated tabs look consumer-specific;
- distinguish connection, subscription, stream, and view state;
- keep common consumer choices visible while progressively disclosing tuning;
- distinguish Kafka records from local lifecycle activity;
- make large topic lists searchable and safer to operate;
- present single, batch, stream, and transaction production as explicit modes;
- provide effective defaults, units, accessible labels, and actionable guidance.

Kafka remains desktop-only. This work does not change IPC contracts, persisted
Kafka connection schemas, native dependency behavior, or security boundaries.

## Interaction Model

### Client shell

The shell header describes only connection-wide context:

- protocol, broker, and default topic;
- connection state;
- disconnect and delete-connection actions.

Consumer start-position controls move from the shell into the Consume tab.
Message-view freezing moves into the Messages tab. Subscription and stream
state appear in the Consume tab beside the corresponding controls.

This establishes four distinct states:

1. **Connection:** disconnected, connecting, connected, or error.
2. **Subscription:** idle, subscribing, subscribed, or error.
3. **Consumer stream:** running or paused.
4. **Message view:** live or frozen.

Each state is shown only where users can act on it.

### Consume tab

The Consume tab is ordered by task:

1. consumer group and topics;
2. start position;
3. delivery behavior;
4. subscription controls;
5. optional performance tuning.

Start position uses a labelled select rather than a five-item segmented strip.
Manual offset and timestamp inputs remain conditional.

Commit policy, isolation, group protocol, and committed-offset fallback form a
visible “Delivery” section. Static membership and broker timing/fetch controls
move into a collapsed “Performance tuning” section. Optional numeric controls
show their units and effective native defaults through helper text or
placeholders; blank continues to mean “use the client default.”

The footer uses one clear primary action for the current state:

- Subscribe while idle;
- Unsubscribe while subscribed;
- Pause consumer while running;
- Resume consumer while paused.

Subscription and stream badges remain nearby, without duplicating raw status
text.

### Messages tab

The message workspace owns the Live/Frozen view toggle.

Local lifecycle entries such as Connected, Subscribed, Paused, and Resumed are
rendered as activity rows with an event icon and “Activity” type. They do not
pretend to have a Kafka partition or offset. Kafka records retain partition,
offset, timestamp, key, value, headers, tombstone state, and manual-commit
controls.

The inspector shows a compact record summary before raw content. Tombstones use
a semantic badge and explanatory text instead of relying only on the literal
`<tombstone>` value.

### Produce tab

Production workflows use four explicit modes:

- **Single record**
- **Batch**
- **Stream**
- **Transaction**

Single record remains the default. Mode switching changes only producer UI
state and does not mutate connection configuration.

The single-record editor groups key, headers, routing, and value in scanning
order. The value encoding selector stays adjacent to the Value label.
Enabling tombstone visibly disables the value editor and explains that Kafka
will receive a null value. The primary send action stays visible at the bottom
of the active mode.

Batch, stream, and transaction controls move out of a generic accordion and
into their corresponding modes. Existing mutual-exclusion and serialized
session safeguards remain unchanged.

### Admin tab

Topics gain:

- a topic count;
- client-side filtering;
- a stable header explaining topic and actions;
- meaningful unloaded, loading, empty, and no-match states;
- a labelled action menu or labelled action buttons with destructive styling.

Topic inspection remains inline. Delete continues through the existing
confirmation dialog.

Consumer groups use the same count-and-state vocabulary where applicable.
Advanced administration remains progressively disclosed because it targets
expert workflows. Its result panel identifies the most recent operation and
uses a polite live region for success or failure feedback.

## Component Boundaries

The existing `KafkaClient` remains the orchestration boundary. It retains
connection selection and request dispatch but no longer renders
consumer-specific or message-view controls in the shared header.

Presentation responsibilities remain isolated:

- `KafkaConsumerPanel` owns start position, subscription state, and tuning.
- `KafkaMessagesPanel` owns view freezing and record/activity presentation.
- `KafkaProducerPanel` owns producer mode selection and mode-specific forms.
- `KafkaAdminPanel` owns topic/group discovery and filtering.
- `KafkaAdvancedAdmin` owns advanced operation feedback.

Small internal components may be extracted when a panel would otherwise become
harder to read. No new global store is required; filter, disclosure, and
producer-mode values are local ephemeral UI state.

## Accessibility and Responsive Behavior

- Every control has a visible label or accessible name.
- Icon-only destructive controls keep tooltips and explicit ARIA labels.
- State changes use text plus icon/badge, never color alone.
- Dynamic operation results use `aria-live="polite"`.
- Details/summary controls remain keyboard-native.
- Two-column option grids collapse to one column at narrow widths.
- Headers wrap without overlapping the broker/topic identity or actions.
- Focus order follows the visual task order within each tab.

## Error Handling

Existing protocol errors remain the source of truth. UI-only validation adds:

- numeric unit/range hints before submission;
- no-match feedback for topic filtering;
- invalid JSON feedback in advanced ACL operations without crashing render;
- operation-specific result labels for advanced administration.

Destructive operations retain typed confirmation and confirmation dialogs.

## Verification

### Automated component tests

- shell does not render consume-mode or freeze controls;
- Consume owns start-position and subscription/stream state;
- performance tuning is collapsed by default and exposes native-default hints;
- Messages distinguishes activity rows from records and owns Live/Frozen;
- producer modes render the correct workflow and tombstone disables value;
- Admin filters topics, reports counts/no matches, and preserves safe deletion;
- advanced operation results are labelled and announced.

### Repository and integration gates

- focused Kafka component/store/manager tests;
- full merged Vitest coverage;
- architecture, full type-check, lint, and format checks;
- Electron renderer build;
- desktop-only navigation E2E;
- live Redpanda Kafka E2E covering produce, consume, pause/resume, manual commit,
  transactions, binary records, headers, and tombstones.

### Visual review

Inspect Connection, Produce, Consume, Messages, and Admin at desktop width and a
narrow renderer width. Verify hierarchy, wrapping, focus order, empty states,
destructive affordances, result feedback, and a clean renderer console.

## Acceptance Criteria

The work is complete when all seven approved improvements are visible in the
built Electron client, automated regressions cover the changed interaction
model, the live Redpanda flow still passes, and repository/hosted checks remain
green.
