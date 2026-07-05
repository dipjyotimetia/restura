# Settings Redesign — Design

**Status:** Approved, ready for implementation plan
**Date:** 2026-07-05
**Owner:** Dipjyoti Metia
**Scope:** Settings only. AI Chat gets its own follow-up spec using the same visual language.
**Platform:** Shared renderer — web (Cloudflare Pages) and Electron. The AI section is desktop-gated (`isElectron()`/`ai.*` capability flags) and keeps that gate, with a better-designed fallback on web. Secrets is available on both platforms already (OS keychain on desktop, encrypted IndexedDB on web) and is not gated — restyled only, no fallback needed.

---

## 1. Goal

Replace the current Settings drawer — a 2018-line monolithic `SettingsDrawer.tsx` with a custom, ad-hoc section switcher — with a dedicated, premium-feeling Settings surface: a persistent sidebar of sections, a searchable entry point, and card-grouped content that matches an Arc/macOS-native aesthetic. Reuse Restura's existing "Spatial Depth" OKLCH design tokens (`sp-floater`, `sp-floater-lg`, `--sp-accent`, etc.) rather than introducing a new visual language. Split the monolith into a `src/features/settings/` feature module along the way, matching the modular pattern every other feature in the codebase already follows.

## 2. Non-goals

- **AI Chat redesign.** Tracked as a separate spec; this pass only touches the Settings surface (including the AI _section_ within Settings, e.g. provider config and Judge settings, but not the `src/features/ai/` chat panel itself).
- **Field-level search / deep-linking to a specific setting inside a section.** v1 search is section-level only (title + curated keywords). Jumping straight to a highlighted field is a reasonable fast-follow, not in scope here.
- **New settings or new capabilities.** No new toggles/fields beyond relocating the existing AI-Lab Judge config from the Requests section into the AI section. This is a navigation/visual/structural redesign, not a features change.
- **A separate native OS window (Electron `BrowserWindow`).** Settings stay in the same renderer/window as a full-page route, not a second window — keeps web and desktop identical and avoids new IPC/window-management surface.
- **Changing the underlying settings data model.** `useSettingsStore.ts` (Zustand + persist + Zod validation) is unchanged; only the presentation layer and a small amount of transient (non-persisted) UI state (search query, active section) are added.
- **Certificates/Secrets functional changes.** Their current behavior (mTLS, per-domain certs, OS-keychain-backed secrets) carries over as-is, restyled only.

## 3. Decisions (locked during brainstorm)

| Decision              | Choice                                                                                                                                                                                           | Reason                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container             | Full-page route (`/settings/:sectionId`) inside the existing `createHashRouter`, not a drawer or a second Electron window                                                                        | Works identically on web and desktop; no new window-management/IPC surface; still reads as a dedicated space via full-viewport takeover + transition                                                                                                                                                                                                   |
| Navigation pattern    | Persistent labeled left sidebar (icon + label per section), always visible                                                                                                                       | Matches macOS System Settings / Arc; no per-section-change navigation hop (rejected the grid-launcher/drill-down alternative for this reason); single click to any section                                                                                                                                                                             |
| Search                | Pinned search input at the top of the sidebar; section-level fuzzy match against title + curated keyword list per section                                                                        | Closes a real gap (modern settings UIs all have search) without building a full field-level search index                                                                                                                                                                                                                                               |
| Judge/scorer settings | Move from nested-in-Requests to a subsection of AI                                                                                                                                               | Judge config is AI-Lab-specific, not a request-execution default; cleaner mental model                                                                                                                                                                                                                                                                 |
| AI section on web     | Stays visible in the sidebar; content pane shows a designed "available on desktop" card instead of the current bare fallback message                                                             | A gated feature should still feel like a deliberate platform boundary, not a dead end                                                                                                                                                                                                                                                                  |
| Code structure        | Split `SettingsDrawer.tsx` into a `src/features/settings/` feature module (one file per section + shared field primitives)                                                                       | Matches the codebase's existing per-feature module pattern; 2018 lines in one file is the outlier, not the norm                                                                                                                                                                                                                                        |
| Visual system         | Reuse existing Spatial Depth tokens — flat `sp-floater`/`sp-inset` panels, `--sp-accent`, OKLCH ladder — no new token set                                                                        | CLAUDE.md/[[project_glass_design]] already establishes this system; extending it beats introducing a second one                                                                                                                                                                                                                                        |
| Sidebar surface       | Flat `.sp-floater` (opaque, hairline border), not frosted `.sp-floater-lg`                                                                                                                       | The codebase documents `.sp-floater-lg` as reserved for transient overlays (dialogs/command palette/popovers) and flat panels as the deliberate "pro instrument density" language for persistent UI (see `Floater.tsx` and `globals.css` comments) — the sidebar is persistent, so it follows the flat convention rather than carving out an exception |
| Entry points          | Same triggers as today (Electron native menu `menu:settings` / ⌘, accelerator, in-app buttons, shortcuts-help button), swapped from `setSettingsOpen(true)` to `navigate('/settings/<section>')` | No behavior change for how users reach Settings, only what renders once they do                                                                                                                                                                                                                                                                        |

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/features/settings/                                              │
│                                                                       │
│  SettingsPage.tsx            route element for /settings/:sectionId  │
│                               owns: active section from URL param,   │
│                               search query (transient, useState)      │
│                                                                       │
│  components/                                                         │
│    SettingsSidebar.tsx        section list, icon+label rows,          │
│                               active-row accent highlight             │
│    SettingsSearch.tsx         pinned input; filters SettingsSidebar   │
│                               via section keyword index               │
│    FieldGroup.tsx             card-panel wrapper (was inline in       │
│                               SettingsDrawer.tsx, now shared)          │
│    FieldRow.tsx, SectionHeader.tsx, SectionLabel.tsx                  │
│                               (promoted out of the monolith, same     │
│                               responsibilities, restyled)             │
│                                                                       │
│  sections/                                                           │
│    GeneralSection.tsx, AppearanceSection.tsx, RequestsSection.tsx,    │
│    ProxySection.tsx, CertificatesSection.tsx, SecretsSection.tsx,     │
│    AiSection.tsx              absorbs ProviderSettings (lazy-loaded,  │
│                               unchanged) + Judge/scorer config         │
│                               (moved from RequestsSection)             │
│    DataSection.tsx, UpdatesSection.tsx, ShortcutsSection.tsx,         │
│    AboutSection.tsx                                                  │
│                                                                       │
│  lib/                                                                │
│    sectionSearchIndex.ts       static { sectionId, title, keywords[] }│
│                               list + fuzzy-match helper               │
└──────────────────────────────────────────────────────────────────────┘
                     │ reads/writes (unchanged)
                     ▼
          src/store/useSettingsStore.ts   (Zustand + persist + Zod)
```

`src/routes/index.tsx` changes: the `settingsOpen`/`settingsInitialSection` state and the `<SettingsDrawer>` mount are removed. The four call sites that currently do `setSettingsInitialSection(x); setSettingsOpen(true)` (native menu handler, two `onOpenSettings` callbacks, shortcuts-help trigger) become `navigate(\`/settings/${x}\`)`. A new route entry is added to the router tree: `{ path: 'settings/:sectionId?', element: <SettingsPage /> }`.

`SettingsDrawer.tsx` and its co-located test file are deleted once the new module is in place and passing; this is a like-for-like replacement, not an additive one.

## 5. Layout & visual system

- **Sidebar** — ~240px fixed width, flat `.sp-floater` (opaque, hairline border) — matches the codebase's "pro instrument density" convention for persistent panels; frosted `.sp-floater-lg` stays reserved for transient overlays only. Section rows: leading icon (lucide, consistent with icons used elsewhere in the app chrome) + label. Active row: `--sp-accent`-tinted background plus a left accent bar. Hover: existing `--sp-hover-bg`.
- **Search** — pinned input at the top of the sidebar, below any header, above the section list. Typing filters the visible section rows in place (no modal/popover); clearing the input restores the full list.
- **Content pane** — left-aligned, max-width ~720px (does not stretch full-width on large displays — matches macOS System Settings' restrained content width), large section title + one-line description at the top. Fields are grouped into rounded card panels (`sp-floater`) with hairline borders, replacing today's flat `FieldGroup`/`FieldRow` stack. Spacing: generous internal card padding, clear vertical rhythm between cards (more breathing room than the current cramped `text-[10px]`/`text-[11px]` density noted in the audit).
- **Transitions** — section switch and the initial route mount use the existing `src/components/ui/motion` primitive for a short (~180ms) fade/slide; no bespoke animation code.
- **Accent color** — `--sp-accent` drives active nav state, switch/toggle "on" states, and focus rings throughout, consistent with the Arc-style "playful accent" direction.

## 6. Section content plan

Same 10 sections as today, one change in grouping:

| Section      | Change from current                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General      | Restyle only                                                                                                                                                                  |
| Appearance   | Restyle only                                                                                                                                                                  |
| Requests     | Judge/scorer config **removed** (moved to AI)                                                                                                                                 |
| Proxy        | Restyle only                                                                                                                                                                  |
| Certificates | Restyle only (largest section; card-grouping helps its density most)                                                                                                          |
| Secrets      | Restyle only                                                                                                                                                                  |
| AI           | Absorbs Judge/scorer config; web fallback redesigned as a card explaining the desktop-only boundary (still gated by the same `ai.basic`/`ai.toolCalls`/etc. capability flags) |
| Data         | Restyle only                                                                                                                                                                  |
| Updates      | Restyle only                                                                                                                                                                  |
| Shortcuts    | Restyle only                                                                                                                                                                  |
| About        | Restyle only                                                                                                                                                                  |

## 7. Search implementation

`lib/sectionSearchIndex.ts` exports a static array: `{ sectionId, title, keywords: string[] }[]`, hand-authored per section (e.g. Proxy → `["proxy", "socks", "pac", "http proxy"]`; Certificates → `["mtls", "ca", "client cert", "custom ca"]`). `SettingsSearch.tsx` does a simple case-insensitive substring/fuzzy match against title + keywords on each keystroke (no new dependency — reuse the same filter approach the existing `Command`/`cmdk`-backed `CommandPalette.tsx` already uses, for consistency) and passes the filtered id list down to `SettingsSidebar.tsx`. No results → sidebar shows an inline "No settings found for '…'" empty state instead of an empty list.

## 8. Data flow & state

No change to how settings values are read or written — `useSettingsStore.updateSettings(...)` remains the single write path, unchanged validators, unchanged persistence (Dexie on web, encrypted electron-store on desktop). The only new state is transient and UI-only:

- **Active section** — comes from the `:sectionId` URL param, not the store. Enables deep-linking (`/settings/certificates`) and browser back/forward to move between sections.
- **Search query** — local `useState` in `SettingsPage.tsx`, never persisted.

## 9. Error handling & edge cases

- **Unknown/stale `:sectionId`** (e.g. a bad deep link) — redirect to `/settings/general`.
- **AI section, web build** — render the existing capability-gate check (`isElectron()` / `ai.basic` etc.) but replace the current bare fallback text with a designed empty-state card ("Available on desktop — the AI assistant runs entirely in the Electron app so your API key never leaves your machine").
- **Search with zero matches** — inline empty state in the sidebar, content pane keeps showing whatever section was last active.
- **Keychain unavailable, cert validation errors, per-domain cert list, secrets list** — all existing error/empty states carry over unchanged, just restyled inside the new card layout.

## 10. Testing

- Replace `src/components/shared/__tests__/SettingsDrawer.test.tsx` with tests under `src/features/settings/__tests__/`:
  - `SettingsPage` renders all 10 sections and switches correctly on sidebar click.
  - Deep link (`/settings/certificates`) mounts directly into the right section.
  - Search filters the sidebar list; a query matching no section shows the empty state.
  - AI section renders the gated fallback card on a mocked `isElectron() === false`, and the real provider settings when `true`.
  - Judge/scorer fields render under AI, not under Requests.
- Manual verification pass (per repo convention of testing UI changes in a browser/app, not just unit tests): run `npm run dev` for the web path and `npm run electron:dev` for desktop, confirm sidebar vibrancy renders on Electron and degrades cleanly on web, confirm the native `⌘,` accelerator and in-app buttons land on `/settings/general`.

## 11. Migration notes for the implementation plan

- This is a delete-and-replace of `SettingsDrawer.tsx`, not an incremental strangler — the file is small enough in scope (one feature) to cut over in one plan.
- Because `ProviderSettings.tsx` (`src/features/ai/components/ProviderSettings.tsx`) is lazy-loaded into the AI section today, keep that lazy-loading in the new `AiSection.tsx` — no change to AI feature bundle-splitting.
- `capabilities.ts` is unchanged — this redesign doesn't alter what's gated, only how the gate is presented.
