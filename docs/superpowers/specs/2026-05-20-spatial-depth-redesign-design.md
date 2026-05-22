# Spatial Depth Redesign — Design Spec

**Date:** 2026-05-20
**Reference handoff:** [`docs/design_handoff_restura_redesign/README.md`](../../design_handoff_restura_redesign/README.md)
**Status:** Draft, pending user approval

---

## 1. Goal

Re-skin the entire Restura renderer in the **Spatial Depth** design language (floating layered panels over a starlit cobalt void, macOS-style chrome, soft glass blurs, glowing cobalt accents, dark-first with full light parity) without touching the underlying data model, transport, or protocol-execution layers.

This is a **visual-layer rewrite**, not an architecture rewrite. Every existing user flow — sending HTTP, gRPC reflection, streaming SSE, MCP tool invocation, Kafka subscription — works identically afterwards.

---

## 2. What stays untouched

These are explicitly out of scope; they are already in good shape and changing them would balloon the work.

| Layer | Why it's untouched |
| --- | --- |
| `shared/protocol/` (SSRF guard, header policy, body builder, auth signers, all `*-proxy.ts`) | Backend-agnostic wire layer; already validated |
| `worker/handlers/*` and `electron/main/*-handler.ts` | Per ADR-0006 they're the thin Fetcher adapters |
| `useRequestStore.tabs[]` + `activeTabId` shape | Already protocol-agnostic; matches the new design's multi-tab model |
| All other Zustand stores (`useCollectionStore`, `useEnvironmentStore`, `useHistoryStore`, `useSettingsStore`, `useWorkflowStore`, per-protocol stores) | Persistence + validators stay as-is |
| Hash router (`createHashRouter`, single `Home` route) | Design is single-page; no routing change needed |
| Script sandbox (QuickJS) | Sandbox is invisible to the redesign |
| `src/lib/opencollection/`, importers/exporters | Data layer |
| Electron IPC bridge + rate limiter | Boundary contracts stable |
| `lucide-react` icon library | Already the standard; matches handoff's Lucide-compatible icon set |
| `framer-motion` | Already used; keeps the slide/fade transitions |
| Radix UI primitives as behavioural substrate | Composes well with the new visual atoms; no shadcn migration |

---

## 3. What changes

| Layer | Change |
| --- | --- |
| `tailwind.config.ts` | New token system: `bg`, `surface[Hi\|Lo]`, `text[Muted\|Dim]`, `line[Strong]`, `accent` (CSS-var driven), `code`, `hoverBg`, `activeBg`; method/protocol color tables; type scale; radius scale (7/8/9/12/14/16); shadow recipes (`shadow-float`, `shadow-floatLg`, `shadow-accentGlow`) |
| `src/styles/globals.css` | Replace `.glass-1/2/3` with new shadow recipes layered with `backdrop-filter: blur(24px) saturate(180%)`; add `bgGlow` radial-gradient background; load **JetBrains Mono** alongside Geist; cursor-blink keyframe for SSE; `slideIn` keyframe for drawers; `{{var}}` highlight utility |
| Font stack | UI: Geist (already in use, keep) · Mono: **switch from Fira Code → JetBrains Mono** to match spec exactly |
| Layout shell | `TopBar` → new `WindowChrome` (44 px, traffic-light slot on Electron mac, plain on web/win/linux, centred env pill); `IconRail` + current `Sidebar` → new unified `Sidebar` (268 px floater); `TabBar` → new `TabStrip` (floating pill style); `StatusBar` rebuilt at 28 px; `NetworkConsole` → new `ConsoleDrawer` (32 collapsed / 232 expanded) |
| Protocol views | All seven (HTTP, GraphQL, gRPC, WebSocket, SSE, MCP, Kafka) rebuilt to spec composition; logic untouched |
| Overlays | `CommandPalette` refreshed (grouped, ⌘K nav); `KeyboardShortcutsPanel` folds into a new `SettingsDrawer` (760 px right drawer with 8-section nav); new `EnvSwitcher` popover anchored to sidebar env footer |
| Settings → Appearance | Exposes accent picker (6 presets per spec), theme toggle, density (existing), font (existing) |

---

## 4. New shared atoms

Co-located under `src/components/ui/spatial/`. Each is < 100 LOC, no business logic.

| Atom | Purpose |
| --- | --- |
| `Floater.tsx` | Universal floating panel. Props: `radius` (12/14/16), `elevation` (`float \| floatLg`), `inset` (boolean for surfaceLo), `blur` (bool). Renders `<div>` with the canonical shadow recipe |
| `MethodChip.tsx` | Colour-coded HTTP/gRPC/WS/MCP/SSE/GQL method chip per the spec's method-colour table |
| `ProtoChip.tsx` | Protocol-type chip (HTTP / gRPC / WS / GQL / MCP / SSE / Kafka) |
| `StatusPill.tsx` | HTTP status pill with `2xx → green`, `4xx → amber`, `5xx → red` |
| `Stat.tsx` | Mini stat tile: label (10.5 px / 700 / uppercase) over value (mono) |
| `Kbd.tsx` | Keyboard shortcut chip (mono 11, surfaceLo, 7 radius) |
| `VariableText.tsx` | Tokenises `{{varName}}` to amber pill inline; used in URL field, params, body editor, console rows |
| `ToggleField.tsx` · `Segmented.tsx` · `Stepper.tsx` · `TextField.tsx` | Settings-drawer controls |
| `SubTabBar.tsx` | The 2 px accent-underlined sub-tab bar used inside every protocol view |
| `ParamRow.tsx` | 28 / 1fr / 1.5fr / 1fr / 22 grid row used by Params and Headers tables |
| `WaterfallBar.tsx` | 220 × 8 stacked-segment bar (DNS / TCP / TLS / Request / Wait / Download) with TTFB accent inset glow |
| `CodeEditorFrame.tsx` | Wraps the existing editor; adds 40 px gutter, mono 11.5, `surface=code` background, and `{{var}}` overlay |

These atoms are **the language of every screen** — building them first means every subsequent phase composes from a small, consistent vocabulary.

---

## 5. Phases (delivery order)

Each phase ends with the app still bootable. No phase strands the codebase mid-rewrite.

### Phase 0 — Token foundation (~1 day)

1. Update `tailwind.config.ts` with the Spatial Depth token set.
2. Update `src/styles/globals.css`: new CSS vars (accent driven by user pref), `bgGlow` radial gradient on `body`, JetBrains Mono import, drop Fira Code, new `@keyframes blink` / `slideIn`.
3. Wire `useSettingsStore.accent` → CSS var (default `#4d9fff`); expose presets `[#4d9fff, #7c5cff, #22c55e, #f59e0b, #ef4444, #06b6d4]`.
4. Verify no existing component visibly regresses: most current `.glass-*` classes get aliased to the new shadow recipes so the legacy UI still renders.

### Phase 1 — Shared atoms (~2 days)

Build every atom in §4 with Vitest unit tests (snapshot per colour variant). Storybook-style review page at `src/routes/__spatial-preview/` (dev-only, gated by `import.meta.env.DEV`) for visual sign-off.

### Phase 2 — Shell rewrite (~3 days)

Replace shell components in dependency order:

1. `WindowChrome` (replaces `TopBar`) — 44 px, traffic lights slot, centred env pill, search pill + sparkle + cog on right.
2. `Sidebar` (merges `IconRail` + current `Sidebar`) — 268 px floater, org header, quick find, segmented Collections / History / Workflows, content area, env footer.
3. `TabStrip` (replaces `TabBar`) — floating pill, proto chip + name + dirty dot + close, `+` at end.
4. `StatusBar` — 28 px, env dot with halo, request counter, auto-save, protocol info, ⌘K hint.
5. `ConsoleDrawer` (replaces `NetworkConsole`) — collapsed 32 / expanded 232; level counters; filter pills; grid rows.

After Phase 2 the app shell looks Spatial; protocol panes inside still look legacy until subsequent phases swap them.

### Phase 3 — HTTP view (~3 days)

The workhorse. Compose `UrlBar` (method chip + URL with `{{var}}` highlighting + send button gradient) over a 1 : 1.2 two-column floater pair. Left panel sub-tabs (Params / Headers / Body / Auth / Scripts / Settings) and right panel sub-tabs (Body / Headers / Cookies / Timeline / Tests) with the `WaterfallBar` and `Stat` strip.

### Phase 4 — GraphQL view (~2 days)

Three-column composition: schema explorer 220 px (wired to existing `useGraphQLSchemaStore`) / query editor (with Variables strip) / response. GraphQL syntax-highlight colours per spec.

### Phase 5 — gRPC view (~2 days)

Three-column: service tree 280 px / method invocation + body editor / response with trailers grid.

### Phase 6 — WebSocket view (~1.5 days)

Connection bar + stats row + event log (left, 1.4 fr) + selected-message viewer & compose stack (right).

### Phase 7 — SSE view (~1 day)

URL bar + stats row + event timeline rail (1 px line at x=96, halo-ringed dots) + assembled output with blinking cursor + counters grid.

### Phase 8 — MCP view (~1 day)

Connection bar + three columns: tools list 300 px / invoke form / result viewer (`code` background).

### Phase 9 — Kafka view (~1 day)

Connection bar + stats row with partition pills + 5-col message log + detail panel with headers grid.

### Phase 10 — Overlays (~2 days)

1. `CommandPalette` — grouped results (Requests / Actions / New / Settings), 2 px accent left border on highlighted row, ⌘K toggle, ↑↓ nav, ↵ select.
2. `SettingsDrawer` — 760 px right drawer with `slideIn .25s cubic-bezier(.2,.7,.3,1)`; 8 sections (General / Appearance / Requests / Proxy / Certificates / Secrets / Shortcuts / About). Accent picker lives in Appearance.
3. `EnvSwitcher` — popover anchored at the sidebar env footer; coloured dots with halos; active env has 2 px accent left border + check icon.

### Phase 11 — Polish & cleanup (~2 days)

- `{{var}}` tokeniser applied everywhere (URL field, params, headers, body editor, console rows).
- Confirm method / proto colour tokens are theme-aware in light mode.
- Light theme parity sweep on every screen.
- Remove dead legacy CSS classes (the Phase 0 aliases) and dead components (`IconRail`, old `TopBar`, etc.).
- Delete `__spatial-preview` route from Phase 1.

### Phase 12 — Electron-specific finish (~1 day)

- Set `titleBarStyle: 'hiddenInset'` in `electron/main/window-manager.ts`.
- Mark `WebkitAppRegion: drag` on empty chrome zones; `no-drag` on interactive elements.
- macOS only: position env pill to the right of traffic lights; verify pixel offsets at 1440×900 baseline.
- On web build (`VITE_IS_ELECTRON_BUILD !== 'true'`), traffic lights slot is empty; chrome height stays 44 px.

**Total: ~22 single-dev days, or ~12 days with two devs parallelising after Phase 1.**

---

## 6. Reasonable-call decisions made up-front

In auto-mode I made these calls so the spec is unambiguous. Flag any to revise.

1. **Mono font: JetBrains Mono.** Spec calls for it; current Fira Code is a swap-out (one font-family edit).
2. **No shadcn/ui migration.** Current code uses raw Radix; introducing shadcn wrappers mid-redesign doubles the surface area. New atoms live in `src/components/ui/spatial/`.
3. **Web chrome keeps 44 px height** but renders the traffic-light slot empty (browser handles window controls).
4. **Accent presets persisted in `useSettingsStore.accent`** (new field, default `'#4d9fff'`); CSS variable `--accent` updated reactively.
5. **`Stage` viewport scaler is not ported.** App fills the native window. Min-width 1200 px (sidebar collapses to an icon rail below that, per handoff note — out of scope for the initial rebuild, tracked as Phase-11 stretch).
6. **Tweaks panel from `tweaks-panel.jsx` is not ported.** It's a prototype-only concern; its functionality lives in Settings → Appearance.
7. **Syntax highlighting stays on the existing regex implementation** for this rebuild. Shiki/Monaco migration is acknowledged as a future improvement, not part of this scope.
8. **Existing `KeyboardShortcutsPanel` is absorbed into `SettingsDrawer → Shortcuts`** rather than kept as a separate dialog.
9. **`Socket.IO` view** (audit found it exists alongside WS) is **rebuilt with the same composition as WebSocket**, sharing the new components — no separate spec section.

---

## 7. State / store changes

Only one additive change:

```ts
// src/store/useSettingsStore.ts
type SettingsState = {
  // ...existing fields
  accent: '#4d9fff' | '#7c5cff' | '#22c55e' | '#f59e0b' | '#ef4444' | '#06b6d4';
};
```

Default `'#4d9fff'`. Persisted via the existing Dexie / secure-storage adapters; no migration needed because Zod schema in `store-validators.ts` will accept undefined → default.

No schema changes to any other store.

---

## 8. Testing strategy

| Layer | What we test |
| --- | --- |
| **Unit (Vitest)** | Atom colour variants (MethodChip, ProtoChip, StatusPill), VariableText tokeniser, ToggleField on/off, Segmented selected index |
| **Component (RTL)** | WindowChrome renders env pill + opens EnvSwitcher; TabStrip dirty dot toggles with `isDirty`; ConsoleDrawer collapse/expand; CommandPalette ↑↓ + ↵ select |
| **Visual regression (Playwright)** | Screenshot per protocol view at 1440 × 900, dark + light; CommandPalette open; SettingsDrawer open |
| **Keyboard (Playwright)** | ⌘K opens palette, Esc closes, ⌘, opens settings; arrow nav inside palette |
| **Accent switching (Playwright)** | All 6 presets render without text contrast violations |
| **Light theme parity (Playwright)** | Every screen renders without missing tokens |

Existing protocol e2e suites (`real-http.spec.ts`, gRPC, SSE, MCP, etc.) **must continue to pass unchanged** — proves the wire layer is untouched.

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Phase 2 ships a Spatial shell wrapping legacy protocol panes — looks inconsistent for a beat | Time-box Phase 3 (HTTP) immediately after to land the workhorse; gate Phase 2 release behind a feature flag if Phase 3 slips |
| `glass-*` class aliases left behind after Phase 11 cleanup | Final-phase grep for `glass-1\|glass-2\|glass-3` returns zero matches as cleanup gate |
| Accent custom colour fails contrast (e.g. yellow on light theme) | Limit picker to the 6 presets; reject custom input in v1 |
| JetBrains Mono swap breaks code-editor metrics | Verify column-width calculations in `CodeEditorFrame` after font swap; both fonts are 0.6em width, low risk |
| Electron `hiddenInset` regression on Windows / Linux | Conditional in `window-manager.ts`: only mac uses `hiddenInset`; win/linux fall back to default chrome (chrome height stays 44 px) |
| Hidden coupling between `NetworkConsole` and protocol views | Map current call sites before deletion; Phase 11 gate is "all NetworkConsole imports removed" |

---

## 10. Out-of-scope (explicit non-goals)

- No new protocols.
- No `shared/protocol/` changes (wire layer immutable).
- No Shiki / Monaco editor migration.
- No mobile / responsive < 1200 px (sidebar-collapse stretch goal noted in Phase 11).
- No Tweaks-panel parity.
- No data-store schema migrations (except the additive `accent` field in §7).
- No AI / sparkle-icon functionality (icon ships as no-op per handoff).

---

## 11. Acceptance criteria

The redesign is complete when:

1. Every screen in §15 of the handoff README renders pixel-faithfully at 1440 × 900 in both dark and light themes.
2. All six accent presets switch live with no flicker.
3. ⌘K, ⌘,, Esc, ↑/↓, ↵, ⌘↵ keyboard shortcuts work per §17 of the handoff.
4. All existing Vitest, Playwright e2e, and `npm run validate` checks pass.
5. `git grep -E 'glass-[123]\b|IconRail|TopBar\b|NetworkConsole\b'` returns zero hits in `src/` after Phase 11.
6. Electron mac build shows traffic lights at the correct offset; web build hides them.
7. No new dependencies added other than the JetBrains Mono web-font.

---

## 12. Open questions for the user

These were not knowable from the handoff alone. **Defaults are noted; please confirm or override.**

1. **Roll-out**: behind a feature flag with parallel old/new shells, or hard cut-over per phase? *Default: hard cut-over phase-by-phase (smaller surface area, no flag debt).*
2. **AI sparkle icon**: ship as no-op (per handoff) or wire to a Claude Haiku helper now? *Default: ship as no-op; track separately.*
3. **Sidebar < 1200 px collapse**: include in this redesign or defer? *Default: defer to follow-up.*
4. **Custom accent input** (any hex) vs. only the 6 presets? *Default: 6 presets only, for contrast safety.*
