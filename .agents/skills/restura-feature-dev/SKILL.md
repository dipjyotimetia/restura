---
name: restura-feature-dev
description: Use when adding or changing Restura features, protocols, transports, auth, persistence, or renderer behavior that may differ across web, self-hosted Node, and Electron.
---

# Restura feature development

Start with `openwiki/quickstart.md`, then classify the change as a new protocol,
an extension of an existing protocol, or renderer-only behavior. State the
classification before implementation.

## Invariants

- The same React renderer ships through a Cloudflare Worker, self-hosted Node,
  and Electron. Trace every runtime consumer before editing.
- Network orchestration belongs in `shared/protocol/`; adapters belong in the
  Worker/Node and Electron layers.
- All outbound URL policy flows through `shared/protocol/url-validation.ts`.
- Electron IPC changes require a Zod schema plus validated handler, preload
  bridge, and `electron/types/electron-api.ts` declaration. Preserve rate
  limiting and trusted-sender checks.
- `SecretRef` handles resolve only in Electron main at wire-signing time.
- Persisted state uses Zustand plus the validators in
  `src/lib/shared/store-validators.ts`; do not add localStorage persistence.
- Platform differences are sourced from `src/lib/shared/capabilities.ts`, then
  regenerated with `npm run capabilities:matrix`.

Read the applicable files in `references/` before editing. Use TDD, run
`npm run validate`, then verify applicable web and Electron behavior. For a new
network transport, request reviews from `restura-security-auditor` and
`restura-parity-checker`.
