# Spec: Production-grade React component remediation

## Objective

Bring the product-owned React renderer components to a production-grade standard for accessibility, maintainability, test reliability, and render performance without changing request behaviour or platform capability parity. This work applies to the 188 non-test TSX files under `src/`; it prioritises the eleven grandfathered controller files over 800 lines and the tab-strip accessibility defect found in review.

Success means keyboard users can independently save and close tabs, UI tests run without React `act(...)` warnings, and no production React source requires a grandfathered file-size exception. The web Worker, self-hosted Node server, and Electron renderer must continue to share the same UI behaviour.

## Tech Stack

- React 19 + TypeScript strict mode
- Zustand v5 stores
- Radix UI primitives and the local Spatial UI components
- Vitest + React Testing Library; Playwright for end-to-end checks
- Vite 8; Electron and Cloudflare/Node renderer targets

## Commands

```bash
npm run type-check:all
npm run lint
npm run architecture:check
npm run test:run
npm run test:coverage
npm run build
npm run test:e2e
```

Run focused Vitest files while implementing a task, then the complete gates at each checkpoint. Use `npm run test:e2e:electron` for desktop-only component changes that affect Electron UI behaviour.

## Project Structure

```text
src/components/shared/       Shared renderer surfaces and shell components
src/components/ui/           Reusable primitives; do not add feature behaviour here
src/features/<feature>/      Feature-owned components, hooks, stores, and pure helpers
src/routes/                  Route-level composition and lazy-loading boundaries
src/features/*/__tests__/    Co-located UI and hook tests
tasks/                       This spec, implementation plan, and task checklist
```

## Code Style

Use native controls for actions, explicit feature ownership, focused props, and stable route-level lazy boundaries. A tab action must be a sibling of the tab control, not an ARIA role nested in it.

```tsx
<div className="tab-shell">
  <button role="tab" type="button" aria-selected={isActive} onClick={onSelect}>
    {label}
  </button>
  <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
    <X aria-hidden="true" />
  </button>
</div>
```

- Keep feature-specific orchestration in its feature directory.
- Extract pure mapping, validation, and formatting into typed helpers before extracting view components.
- Prefer a small number of purpose-built hooks over a generic controller framework.
- Preserve stable IDs, existing store contracts, request execution, error boundaries, and lazy imports.
- When a refactor reduces a grandfathered file below 800 lines, remove its entry from `scripts/architecture.config.mts` in the same change.

## Testing Strategy

- Component tests cover keyboard activation, focus order, ARIA roles, error and empty states, and state mutations observable to users.
- Async UI tests use `userEvent`, `findBy*`/`waitFor`, and `act` where an external promise, timer, subscription, or stream advances React state.
- Controller extractions retain existing behaviour tests and add focused tests only for the new public boundary or regression found during extraction.
- Web and Electron flows receive Playwright coverage when a change affects a platform-gated surface, file picker, updater, or connection lifecycle.
- Coverage thresholds and the uncovered-branch budget remain unchanged.

## Boundaries

- Always: preserve three-target renderer parity, retain existing lazy-loading boundaries, run the task's focused tests and the relevant checkpoint gates, and use `architecture:check` to ratchet file size down.
- Ask first: add a dependency, change persistence schemas, alter protocol request behaviour, change Electron IPC, change CI thresholds, or redesign the visual language.
- Never: weaken coverage thresholds, bypass accessibility with role-only controls, move feature logic into `src/components/ui`, add browser `localStorage` persistence, or change SSRF/SecretRef/security boundaries as part of a component refactor.

## Success Criteria

- The tab strip exposes valid, separately focusable native controls for save and close; keyboard tests cover activation.
- The affected shared-component tests are warning-free under React's `act` discipline.
- Every React source file is at or below the 800-line architecture limit; React-specific grandfathered entries are removed rather than increased.
- Every extracted controller preserves its public feature behaviour, current platform gating, and lazy-load boundary.
- `type-check:all`, lint, `architecture:check`, tests with coverage, production build, and applicable web/Electron E2E all pass.

## Open Questions

- None for the remediation plan. The plan deliberately avoids a visual redesign and treats the current route/lazy-load structure as an invariant.
