# PRD 00 — Portfolio Integration & Sequencing

**Status:** Cross-PRD coordination doc (read before implementing any of PRD 01–06)
**Author:** Product (AI)
**Date:** 2026-06-30
**Scope:** PRDs 01–06 target the same codebase. Each was reviewed in isolation (round 1 = code-claim accuracy, round 2 = feasibility/consistency, §16 addenda). This doc is the **end-to-end portfolio review** — the conflicts that only appear when the six are implemented together. Nothing here lives in any single PRD because it spans several.

> **Supersession rule:** Where this doc or a PRD's §16 Round-2 Addendum conflicts with the original body of a PRD, **§16 and this doc win** — the bodies were written first and corrected after. Body spots not yet rewritten are tracked below.

---

## 1. CRITICAL cross-PRD conflicts

| #   | Conflict                                                                                                                                                                                         | PRDs       | Resolution                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | **Dexie schema-version collision** — three PRDs each claim "version 14" for migrations on the same `ResturaDB`. Only one can be v14; they are sequential.                                        | 02, 03, 05 | Assign by merge order (see §2). Current DB is **v13**.                                                                                                                                                                                                               |
| C-2 | **SSRF guard vs. localhost/private-network** — capture proxy must reach localhost dev servers (PRD 05) and OTel backends are on private networks (PRD 06), but the guard blocks both by default. | 05, 06     | PRD 06: dedicated `assertOtelBackendSafe` (fixed in PRD 06 §8.3). PRD 05: **unresolved product decision** — Option A/B/C in PRD 05 §16 R2-1; recommend **Option B** (dedicated capture-proxy `allowLocalhost` toggle, default off). **Gates PRD 05 implementation.** |
| C-3 | **`ResponseViewer.tsx` `ResponseTab` 3-way edit** — PRD 01 adds `'contract'`, PRD 06 adds `'trace'`, PRD 05 adds diff UI, all to the same union (`:112`) and tab-render array (`~:359`).         | 01, 05, 06 | No functional conflict; coordinate the merge. Whoever lands second/third rebases the union + tab list.                                                                                                                                                               |

## 2. Dexie version assignment (by recommended merge order)

```
v13  (current — arenaRuns)
v14  PRD 03  securityFindings table + KAFKA_SECRET_SENTINEL strip migration
v15  PRD 02  KafkaRegistry.auth → { passwordRef?: SecretRef } + stream closeStatus fields
v16  PRD 05  baselines table
```

PRD 04 and PRD 06 require **no** Dexie migration (PRD 06 stores OTel config on the `Environment` object; PRD 01 caches specs in-memory only). If merge order changes, renumber sequentially — the rule is "one bump per PRD, in landing order, never a shared number."

**Each bump must touch all of:** interface declaration + `ResturaDB` table field + `version(N).stores()` + `StorageTableName` union (`dexie-storage.ts:57-81`) + `clearAllData`/`exportAllData`/`importAllData`. Model on the existing `collectionRuns` table. (This checklist is repeated in PRDs 02/03/05 §16.)

## 3. Shared files edited by multiple PRDs

| File                                                   | PRDs               | Merge strategy                                                           |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `src/lib/shared/database.ts`                           | 02, 03, 05         | Sequential version blocks v14→v15→v16                                    |
| `src/lib/shared/dexie-storage.ts` (`StorageTableName`) | 03, 05             | Add both `securityFindings`, `baselines`                                 |
| `src/lib/shared/capabilities.ts`                       | 02, 03, 04, 05, 06 | Coordinated addition (see §4); one regen                                 |
| `src/components/shared/ResponseViewer.tsx`             | 01, 05, 06         | Add `'contract'`, `'trace'` + diff UI to the union + tab list            |
| `shared/protocol/types.ts`                             | 06                 | Sole editor (`otel` on RequestSpec, `otelTraceId` on NormalizedResponse) |
| `shared/protocol/http-proxy.ts`                        | 06                 | Sole editor (traceparent injection, lines 80–122)                        |
| `src/components/shared/ImportDialog.tsx`               | 04                 | Sole editor (4 registration points)                                      |

## 4. Capability-matrix additions (no naming collisions)

16 new `CapabilityName` keys across 5 PRDs — all unique, all follow the existing `domain.feature` convention:

- **PRD 02:** `stream.assertions.{web,kafka,mqtt}`, `stream.schemaRegistry.{kafka,mqtt}`, `stream.crossProtocolFlow`
- **PRD 03:** `security.{bola,authStrip,passiveHygiene,openApiFuzz}`
- **PRD 04:** `import.asyncapi.{kafka,mqtt}`
- **PRD 05:** `diff.{semantic,assertion}`, `capture.proxy`
- **PRD 06:** `http.otelTraceCorrelation`

After **each** PRD lands: `npm run capabilities:matrix` then `npm run capabilities:check` (CI gate). Never hand-edit `docs/CAPABILITY_MATRIX.md`.

## 5. New npm dependencies (supply-chain review)

| Package                              | PRD | Purpose                                                                                                                                                         | Risk                       | Gate                                        |
| ------------------------------------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| `fflate`                             | 04  | Real `.zip` Bruno export on web (optional sub-task; current path is a `bruno-archive/v1` JSON wrapper)                                                          | Low (small, zero-dep, MIT) | Approve before the ZIP sub-task             |
| `@peculiar/x509` **or** `selfsigned` | 05  | X.509 CA cert generation for the TLS capture proxy (Node `crypto` can't issue SAN certs; echo-local shells out to OpenSSL so its CA can't be reused in-process) | Medium (crypto)            | CVE scan + maintenance check before Phase 2 |

## 6. Recommended implementation sequence

**Wave 1 — independent, parallelizable**

- **PRD 01** (Spec Drift) — no Dexie change; `'contract'` tab; **prereq: fix `specLoader.ts` SSRF gap (timeout + redirect guard) first**.
- **PRD 04** (Import Formats) — independent; capability entries only; Bruno export already ships.
- **PRD 03** (BOLA) — Dexie **v14**; **must close the three §16 correctness gaps (skip-scripts, cookie isolation on A, auth-header stripping) before code**; gates PRD 02 on the Dexie line.

**Wave 2 — sequential after Wave 1**

- **PRD 02** (Stream Assertions) — Dexie **v15**; `type-check:all` gate mandatory (the `decodeField` ripple + `exactOptionalPropertyTypes` trap); resolve the API-naming + `WsExchangeNode` open items first.
- **PRD 05** (Diffing + Capture) — Dexie **v16**; **blocked until C-2 localhost decision is made**; diff (both platforms) can ship ahead of capture (desktop).

**Wave 3 — validation-gated**

- **PRD 06** (OTel) — Phase-0 spike with a 20-user / retention gate before the full build; coordinate the `'trace'` tab merge with PRD 01.

## 7. Product decisions (RESOLVED 2026-06-30)

1. **PRD 05 localhost capture** (C-2) — ✅ **Option B**: a dedicated capture-proxy `allowLocalhost` toggle, default OFF, session-scoped, threaded into `resolveSafeAddress`/`validateURL` for proxy connections only. Global Send guard and the cloud-metadata block are never relaxed. PRD 05 §6.2.1 / §9.2 / §16 R2-1 updated. **PRD 05 unblocked.**
2. **PRD 03 BOLA identity-field comparison** — ✅ **User-specified JSON paths** resolved via lodash `get` (already a dependency): nested + indexed-array support, exact-match, explicit `undefined`/`null`/missing rules, status-only fallback for array responses without element paths. PRD 03 §6.2 / §16 R2-5 updated; add nested + array test fixtures in §12.
3. **PRD 06 demand validation** — ✅ **Keep validation-gated (Wave 3)**: run the 2-week Phase-0 spike (traceparent injection + read-only trace-id display) and only build the full waterfall if the 20-user / retention gate passes. No change to PRD 06 scope or sequence.

All three portfolio gates are now resolved; the remaining pre-code work is per-PRD (the §16 correctness items), not cross-PRD.

## 8. Systemic note — body vs. §16 addenda

The round-2 corrections were captured in each PRD's **§16 addendum** but several original body sections still state the pre-correction claim. Fixed inline so far: PRD 04 (`createConnection`), PRD 06 (guard, propagated to §6/§8.2/§8.3/§9.1), PRD 01 (§8.1 renderer-only). Still living only in §16 (body not rewritten, but superseded per the rule above): PRD 02 (assertion API naming, `decodeField` callsites), PRD 03 (§8.1 code example lacks skip-scripts / cookie-isolation / header-stripping), PRD 05 (localhost decision). Treat §16 as authoritative wherever the body conflicts.
