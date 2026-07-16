# Documentation parity map

- Architecture or runtime topology: `AGENTS.md`, `CLAUDE.md`, OpenWiki
  architecture/operations, `docs/ARCHITECTURE.md`, and docs-site architecture.
- Validation, CI, release, or deployment: `docs/CI_CD.md`, OpenWiki testing and
  operations, root agent guidance, and `.codex/README.md` when agent behavior
  changes.
- Capability differences: edit `src/lib/shared/capabilities.ts`, regenerate
  `docs/CAPABILITY_MATRIX.md`, and update user-facing protocol docs.
- New protocol: architecture, capability, protocol docs, self-host/Electron
  notes, and security constraints.
- Architectural decision: next numbered `docs/adr/*.md` plus both the timeline
  and LinkCard grid in `docs-site/src/content/docs/architecture/adrs.mdx`.

An ADR is warranted for a durable cross-cutting boundary, security posture,
persistence contract, platform split, or shipping policy. Small implementation
details belong in existing docs instead.
