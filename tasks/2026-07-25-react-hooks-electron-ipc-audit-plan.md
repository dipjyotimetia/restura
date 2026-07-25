# Audit Plan: Renderer, hooks, and Electron IPC

## Overview

This is a read-only audit plan implementing
`2026-07-25-react-hooks-electron-ipc-audit-spec.md`. It keeps the completed
PR #565 React remediation documents unchanged and produces one combined,
evidence-backed report before any remediation tasks are proposed.

## Architecture Decisions

- Partition the source review by ownership, not file order: renderer components,
  React hooks, and Electron IPC contracts. The partitions do not edit files or
  share mutable state, so they may run in parallel.
- Treat the IPC capability trace as the cross-platform seam: renderer caller →
  typed preload method → canonical channel → validator/trusted sender →
  handler → lifecycle/cleanup → tests.
- Treat Electron-only capabilities as correct only when their renderer gate and
  capability documentation agree. Promised shared-protocol behaviour is traced
  through the Worker/Node and Electron adapters rather than assumed.
- Findings are review output, not implementation. A remediation plan is created
  only after the consolidated audit is reviewed.

## Dependency Graph

```text
Source manifest
     │
     ├── Renderer components ──┐
     ├── React hooks ──────────┼──► Contract/parity and test cross-check
     └── Electron IPC ─────────┘             │
                                               ▼
                               Consolidated severity-ranked audit report
                                               │
                                               ▼
                                Human approval of remediation plan/tasks
```

## Audit Tasks

### Phase 1: Exhaustive independent review

- [x] Task 1: Create and version the audit scope and source manifest rules.
  - Acceptance: all source families and audit axes are explicit; the prior
    completed React plan is preserved.
  - Verify: inspect this plan and the paired specification.
  - Dependencies: None.
- [x] Task 2: Review all active production TSX components.
  - Acceptance: every manifest entry has a disposition and each finding is
    evidence-backed with a focused remedy/test.
  - Verify: manifest count reconciles with the source inventory.
  - Dependencies: Task 1.
- [x] Task 3: Review all active React hooks.
  - Acceptance: lifecycle, cancellation, selectors, and test seams are
    assessed for every manifest entry.
  - Verify: manifest count reconciles with the source inventory.
  - Dependencies: Task 1.
- [x] Task 4: Review the complete Electron IPC contract.
  - Acceptance: every active capability is traced across renderer, preload,
    type, channel, validator, handler, lifecycle, and tests.
  - Verify: used channels are reconciled with declarations and the matrix.
  - Dependencies: Task 1.

### Phase 2: Cross-cutting validation and synthesis

- [x] Task 5: Cross-check findings against platform parity, capability policy,
  security boundaries, architecture policy, and existing tests.
  - Acceptance: false positives are removed; intentional limitations are
    differentiated from defects.
  - Verify: direct source/test evidence supports every retained finding.
  - Dependencies: Tasks 2-4.
- [x] Task 6: Publish the ranked audit report and remediation candidates.
  - Acceptance: findings are severity-ranked and each proposed future task is
    independently testable and roughly five files or fewer.
  - Verify: report links every finding to path:line evidence and verification.
  - Dependencies: Task 5.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Large source count hides omissions | High | Independent manifest totals plus final reconciliation |
| An Electron-only feature is mistaken for parity drift | High | Compare against capabilities source/docs and platform gates |
| A static style issue is presented as a defect | Medium | Retain only behaviour/security/maintenance evidence and label suggestions |
| Agent reviews overlap or alter state | Medium | Fixed read-only ownership partitions; no shared edits |
| IPC security finding lacks a complete contract trace | High | Require the matrix before a finding is retained |

## Checkpoint: Audit completion

- [ ] All three manifests reconcile with current source inventory.
- [ ] Every retained finding has exact evidence, impact, remedy, and test.
- [ ] No production files are changed.
- [ ] Human approves a separate remediation plan before implementation.
