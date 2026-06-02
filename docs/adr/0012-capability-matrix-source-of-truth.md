# ADR 0012: Capability Matrix as a Data-Driven Source of Truth

**Status:** Accepted, 2026-06-02

## Context

One React renderer ships to web, desktop, and self-hosted. Many capabilities exist only on desktop (Kafka, MQTT, mTLS, SOCKS/PAC, OS keychain, mock server, pre-flight DNS guard) because the browser sandbox can't do raw TCP, custom CAs, or subprocesses. If "what works where" lives in scattered `isElectron()` checks and prose docs, the UI, the docs, and reality drift apart — users hit a disabled field with no explanation, or the docs claim a feature the platform doesn't have.

## Decision

Make `src/lib/shared/capabilities.ts` the **single source of truth** for platform parity. Each capability is a keyed entry with `web` / `desktop` booleans and optional `notes`. The renderer reads it to render "Desktop only" badges on the relevant UI fields, and `scripts/generate-capability-matrix.mjs` codegens `docs/CAPABILITY_MATRIX.md` from it. `npm run capabilities:check` is a CI gate (part of `npm run validate`) that fails if the published doc drifts from the code.

When a new feature differs across platforms, you update `capabilities.ts` — never the generated doc by hand.

## Consequences

**Positive**
- UI badges, the published matrix, and the actual gating all derive from one file, so they cannot disagree.
- The CI gate makes drift a build failure rather than a stale-docs bug.

**Negative**
- The docs-site `/reference/capability-matrix/` page is a hand-written prose summary that links to the canonical generated `docs/CAPABILITY_MATRIX.md`; it is not itself codegen'd, so it must be updated by hand when capabilities change. (This ADR's own review surfaced that the summary had gone stale.)
- Capabilities must be enumerated up front; a feature that forgets to add an entry gets no badge and no matrix row.

## References
- Code: `src/lib/shared/capabilities.ts`, `scripts/generate-capability-matrix.mjs`
- Generated: `docs/CAPABILITY_MATRIX.md`; CI gate `npm run capabilities:check`
- Docs: docs-site `/reference/capability-matrix/`
