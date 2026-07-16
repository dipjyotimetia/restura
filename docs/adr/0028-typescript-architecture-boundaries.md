# ADR 0028: TypeScript Architecture Boundaries and Maintainability Gates

**Status:** Accepted, 2026-07-16

## Context

Restura is one TypeScript product compiled into several independent programs: the React renderer, Cloudflare and Node backends, Electron main/preload, the CLI, and extensions. TypeScript project references catch local type errors, but they do not prevent a runtime package from importing in the wrong direction, introducing a cycle, or growing a new monolithic module. Several backend consumers also depended on renderer-owned modules through compatibility paths, which made ownership unclear even when the code happened to compile.

## Decision

The repository has explicit source zones for `shared/`, the renderer, Worker, Electron main/types, CLI, extensions, echo runtimes, and TypeScript tooling. `shared/` is the dependency floor and may not depend on a runtime application. Worker, Electron main, Electron API types, and CLI may not depend on renderer-owned `src/` modules. Renderer compatibility barrels may temporarily re-export shared implementations, but backend consumers import the shared owner directly.

`npm run architecture:check` parses TypeScript syntax and enforces:

- the forbidden zone directions in `scripts/architecture.config.mts`;
- an acyclic runtime import graph (type-only imports do not create runtime cycles);
- an 800-line ceiling for new production TypeScript files;
- exact, non-growing caps for documented legacy oversized modules.

The store/connection-manager cycles were replaced with explicit lifecycle coordinators. Cross-runtime types, schemas, secret/redaction helpers, OpenCollection, MCP-server policy, variable helpers, and the QuickJS executor now live in `shared/`; the old renderer paths are compatibility re-exports only.

The Electron boundary is composed by domain:

- `electron/main/preload.ts` assembles APIs from `electron/main/preload/`;
- `electron/main/ipc/ipc-validators.ts` is a compatibility barrel over `ipc/validators/`;
- `electron/types/electron-api.ts` composes type modules under `electron/types/api/`.

Tooling is checked separately through `tsconfig.tooling.json` and the legacy-JavaScript ratchet in `tsconfig.tooling-js.json`. `npm run validate` is the canonical local/CI contract and runs static checks, root/workspace tests, production builds, Electron compilation, and bundle-size checks.

## Consequences

- Architectural drift fails deterministically before review instead of depending on convention.
- Shared code has one runtime-neutral owner, while renderer compatibility paths avoid a disruptive one-shot migration.
- Existing large modules remain visible debt and cannot grow; removing a grandfathered entry is part of completing a split.
- Adding a source zone, alias, generated-file convention, or intentional dependency direction requires updating the policy and its tests.

## Verification

- `tests/architecture-policy.test.ts`
- `npm run architecture:check`
- `npm run type-check:all`
- `npm run validate`
