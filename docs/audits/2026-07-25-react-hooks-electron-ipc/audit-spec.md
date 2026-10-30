# Spec: Production-grade renderer, hook, and Electron IPC audit

## Objective

Perform a fresh, read-only production-readiness audit of the current Restura
renderer and Electron IPC boundary. The audit is for engineers and coding
agents who need code that is safe to change without rediscovering hidden
lifecycle, privilege, or platform constraints.

The React-controller remediation in `tasks/spec.md` was merged as PR #565.
This audit does not reopen that work by file size alone. It reviews every active
production React component and hook, then traces every Electron IPC capability
end to end: renderer consumer, typed preload API, channel declaration,
main-process validation and trusted-sender check, handler, lifecycle/cleanup,
and tests. It also checks that desktop-only capabilities remain correctly gated
and that shared renderer behaviour keeps its web, self-hosted Node, and
Electron parity contract.

Success is an evidence-backed report in which every in-scope source file has a
recorded disposition (reviewed with no finding, or a severity-labelled finding
with a precise path and line), and every active IPC capability has an end-to-end
contract record. Findings must state a concrete remedy and the smallest useful
test or verification. No production behaviour changes in this phase.

## Tech Stack and Scope

- React 19, TypeScript strict mode, Zustand v5, React Router, Radix UI, and
  Tailwind in `src/`.
- Electron main process, context-isolated preload, `contextBridge`, typed
  `window.electron`, Zod IPC validators, and `ipcMain` handlers in
  `electron/`.
- Vitest + React Testing Library, Playwright web/Electron suites, architecture
  policy, security and cross-runtime parity tests.

The initial manifest is generated from the checked-out tree and refreshed when
the audit begins. It currently contains 239 non-test TSX files, 53 active
`use*` hook files (the filename scan's additional `usebruno-lang.d.ts` is
classified as a type declaration), and the 23 IPC composition/type/validator files below
`electron/main/ipc`, `electron/main/preload`, `electron/types/api`, and
`electron/shared`. It additionally includes every Electron main source that
registers, invokes, sends, listens to, validates, owns, or disposes IPC work.

Generated files, fixtures, third-party code, and deprecated or unreachable code
are not silently excluded: they are classified in the manifest. Worker and Node
implementation details are inspected only where a renderer protocol path needs
parity comparison; this is not a whole Worker audit.

## Commands

```bash
# Produce the scope manifest and identify potential boundary bypasses.
rg --files src -g '*.tsx' -g '!**/__tests__/**' -g '!**/*.test.tsx'
rg --files src -g 'use*.ts' -g 'use*.tsx' -g '!**/__tests__/**' -g '!**/*.test.ts' -g '!**/*.test.tsx'
rg -n "window\\.electron|contextBridge|ipcMain\\.|ipcRenderer|createValidatedHandler" src electron

# Review static policies and all runtime type contracts.
npm run architecture:check
npm run type-check:all
npm run lint

# Run focused tests selected for validated findings, then broader gates for remediation.
npx vitest run <affected-test-files>
npm run test:coverage
npm run build
npm run test:e2e
npm run test:e2e:electron
```

## Project Structure

```text
src/components/ and src/routes/        Shared and route-level React composition
src/features/<feature>/                Feature-owned components, hooks, lib, store, tests
src/lib/shared/                         Renderer-wide platform, persistence, and utilities
electron/shared/channels.ts             Canonical IPC channel names
electron/main/preload/                  Narrow renderer-facing bridge modules
electron/types/api/                     window.electron public API contract
electron/main/ipc/validators/           Zod payload schemas and trusted-sender boundary
electron/main/handlers/                 Privileged protocol/desktop operations
electron/main/ipc/                      Rate limits, streams, cleanup, shared IPC support
shared/protocol/ and worker/            Parity comparison only at renderer transport seams
tasks/                                  This specification and subsequent approved plan/tasks
```

## Code Style and Review Standard

Each source has one clear owner and responsibility. Components compose visible
behaviour; hooks own reusable React lifecycle and stateful orchestration; pure
parsing, mapping, and validation remain typed feature-owned helpers. Select
narrow Zustand selectors and make cleanup, cancellation, and stale-result
ownership explicit. Do not introduce generic controller frameworks or
speculative memoisation.

```tsx
function useConnectionStatus(connectionId: string) {
  const status = useConnectionStore((state) => state.byId[connectionId]?.status);

  useEffect(() => {
    const unsubscribe = subscribeToConnection(connectionId);
    return unsubscribe;
  }, [connectionId]);

  return status ?? 'disconnected';
}
```

An Electron capability is reviewable only when its narrow preload method is
explicitly typed and maps to a declared channel; the main handler validates
untrusted payloads and sender before privileged work; events have a matching
unsubscribe/ownership model; and registration teardown cannot drift from
resource cleanup. The renderer must never receive raw `ipcRenderer` or a
general-purpose privileged bridge.

Every source and contract is assessed for:

1. Correctness and error/cancellation paths.
2. Accessibility, semantic controls, focus, and keyboard behaviour for UI.
3. React lifecycle safety: Rules of Hooks, effect necessity/dependencies,
   subscription/timer/abort cleanup, Strict Mode, and stale async results.
4. Agent-friendly maintainability: feature ownership, explicit types, low
   implicit coupling, clear names, bounded local context, and test seams.
5. Render/runtime performance: store subscription breadth, derived-data
   placement, list/stream bounds, avoidable effects, and evidence-based memoisation.
6. IPC security/resilience: least privilege, context isolation, canonical
   channel ownership, schema/sender validation, rate limits, secret handling,
   SSRF/DNS/protocol guards, serialisable errors, and disposal.
7. Platform/testability: promised Electron/web/self-host parity, intentional
   desktop-only gates, and observable behaviour tests.

## Testing Strategy

- Build a review manifest before source reading and update it as each file is
  dispositioned; a file cannot be omitted because it looks trivial.
- Read existing tests first for each component, hook, or capability family. A
  missing observable error, lifecycle, security, or accessibility test is a
  finding.
- Renderer findings get focused Vitest/RTL tests for user-visible
  error/empty/loading states, keyboard interaction, cancellation, and cleanup.
- Hook findings use a consumer harness to verify subscription, abort,
  stale-result, and unmount behaviour as relevant.
- IPC findings test invalid payload and untrusted sender rejection, canonical
  preload type/channel mapping, success/error serialisation, event
  unsubscribe, and renderer-destroyed cleanup. Security-sensitive transport
  work also runs its SSRF, secret, broker, or parity suite.
- Before approved remediation is complete, run focused tests and then
  `npm run type-check:all`, `npm run lint`, `npm run architecture:check`,
  `npm run test:coverage`, `npm run build`, and applicable web/Electron E2E.
  Coverage thresholds and the uncovered-branch budget remain unchanged.

## Boundaries

- Always: preserve the canonical shared protocol core, capability matrix,
  `SecretRef`, SSRF/DNS/broker protections, context isolation, typed preload
  surface, and paired IPC registration/disposal. Cite path:line evidence and
  label findings Critical, Required, Optional, or Nit.
- Ask first: modify production code, add a dependency, change Electron
  permissions/CSP/security policy, extend IPC, change persistence schemas,
  alter platform support, change CI/coverage policy, or delete suspected dead code.
- Never: expose Node/Electron modules or raw `ipcRenderer` to the renderer,
  weaken schema/sender validation or rate limits, log/transmit secrets,
  introduce browser `localStorage` persistence, weaken test thresholds, or
  claim parity without tracing the complete transport path.

## Success Criteria

- An exhaustive, versioned audit manifest records every active in-scope React
  component, hook, and Electron IPC source with reviewed/no-finding or
  severity-labelled evidence.
- Every renderer-to-main capability has a traceable contract record covering
  consumer, preload API, type declaration, channel, validator, main handler,
  lifecycle owner, cleanup, and tests; intentional exceptions are documented.
- Each finding has impact, precise evidence, a concrete structural remedy,
  platform implications, and a focused verification method.
- The report separates confirmed defects from optimisation ideas and avoids
  speculative refactors or abstractions without demonstrated need.
- Any approved remediation is split into independently verifiable slices of
  roughly five files or fewer, preserves parity, and passes the stated gates.

## Open Questions

1. This assumes the outcome is an exhaustive audit and prioritised remediation
   plan, not immediate code changes. Approve this scope to begin source review;
   after the audit, approve the plan before production remediation.
2. The audit includes Electron-only AI, AI Lab, Kafka, MQTT, Git, and MCP,
   treating their documented desktop-only status as intentional rather than a
   web-parity defect. Confirm if any of these should be excluded.
