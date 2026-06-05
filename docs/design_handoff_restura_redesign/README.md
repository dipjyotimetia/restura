# Handoff — Restura redesign (Spatial Depth direction)

> [!IMPORTANT]
> **This document has two parts.** The **Current implemented system** section
> immediately below is authoritative and reflects the shipped + modernized UI as
> of **2026-06-05**. The original Spatial Depth handoff that follows it (from
> "## Overview" onward) is kept for **historical context** — it was the source
> design, but several of its specifics (glow-heavy floating glass, `#06080f`
> backdrop, `#4d9fff` accent, big float shadows, HSL tokens) have since been
> deliberately superseded. Where they conflict, **this section wins**.

---

## Current implemented system (2026-06-05 modernization)

The Spatial Depth direction was implemented and then modernized end-to-end
(branch `ui/modernize-foundation`, PR #230). The journey: **Spatial Depth
floating-glass → "pro-instrument" flatten** (it read as generic/AI-made) **→
glass re-introduced only where it belongs → OKLCH/Tailwind-v4 foundation +
a11y + richer-cobalt refresh.**

### Design philosophy (current)

- **Two materials, by purpose** (macOS/Linear pattern):
  - **Solid** for things you _read_ — request/response/params, code/JSON panels.
    `.sp-floater` = opaque `var(--sp-surface)` + a single `1px var(--sp-line)`
    hairline. **No drop shadow, no blur.**
  - **Frosted glass** for things that _float over_ other things — overlays
    (dialog, alert-dialog, popover, dropdown, context-menu, tooltip, select
    content, command palette, toaster) via `.glass-1/2/3` + `.sp-floater-lg`,
    and chrome (top bar, sidebar, tab strip, status bar) via `.sp-chrome`.
    Translucent + `backdrop-filter` blur; overlays add a restrained shadow.
- **Dense, calm, flush.** Edge-to-edge square layout (panel radius `0`, hairline
  dividers, near-zero gaps). The earlier always-on glow/orbs/noise were removed;
  a _subtle_ `--sp-bg-glow` backdrop remains so the frosted layer has depth to
  refract. The one saturated element is the primary action (`.sp-cta`, flat
  solid accent — no gradient/glow).
- **Glow discipline.** Accent appears on focus rings + active indicators only;
  no ambient glow on toggles/subtabs/scrollbars/CTAs.

### Token system (current) — single source of truth

`src/styles/globals.css` is the single design-token source. There is **no
`tailwind.config.mts`** — theme is **Tailwind v4 CSS-first** (`@theme {}` +
`@custom-variant dark (&:is(.dark *))`). The legacy shadcn HSL token set has been
**deleted**; legacy utilities (`bg-primary`, `text-muted-foreground`,
`border-border`, `bg-surface-*`, …) now alias the `--sp-*` tokens via `@theme`.

Tokens are **OKLCH**, one declaration each, light/dark resolved by the
`light-dark()` CSS function against `color-scheme` (driven by `next-themes`
`enableColorScheme` + the `.dark` class). Canonical `--sp-*` values:

| Token              | Light (OKLCH)    | Dark (OKLCH)     | Used for                     |
| ------------------ | ---------------- | ---------------- | ---------------------------- |
| `--sp-bg`          | `94.2% .012 260` | `15.5% .011 268` | window/backdrop base         |
| `--sp-surface`     | `100% 0 0`       | `20.5% .015 267` | solid data panels            |
| `--sp-surface-hi`  | `97.3% .006 264` | `24.4% .018 266` | raised / active              |
| `--sp-surface-lo`  | `95.7% .007 261` | `17.8% .013 270` | inset (inputs, code)         |
| `--sp-text`        | `18.9% .028 268` | `95.8% .011 270` | primary text                 |
| `--sp-text-muted`  | text / `.62`     | text / `.62`     | secondary text               |
| `--sp-text-dim`    | text / `.60`     | text / `.55`     | tertiary (WCAG 1.4.3 ≥4.5:1) |
| `--sp-line`        | text / `.10`     | white / `.08`    | hairline dividers            |
| `--sp-line-strong` | text / `.16`     | white / `.14`    | stronger borders             |
| `--sp-accent`      | `66% .19 255`    | `70% .19 255`    | actions, focus, links        |
| `--sp-code`        | `97.9% .006 264` | `16.4% .011 268` | code editor bg               |
| `--sp-hover-bg`    | text / `.04`     | white / `.04`    | row hover                    |
| `--sp-active-bg`   | accent / `.10`   | accent / `.15`   | selected row / active tab    |

- **Accent (signature): richer cobalt `#2e91ff`** (oklch ~66% .19 255), evolved
  from the original `#4d9fff` — deeper, more saturated. It's user-selectable;
  `AccentProvider` (`src/components/providers/AccentProvider.tsx`) writes
  `--sp-accent` + the `--sp-accent-glow-*` ladder to `:root` at runtime from
  `settings.accent`. Swatches: `#2e91ff` (cobalt), `#7c5cff`, `#22c55e`,
  `#f59e0b`, `#ef4444`, `#06b6d4` (`SpatialAccent` in `src/types/index.ts`).
- **Radius scale (flush/square):** `--radius-sp-chip 3 / -btn 4 / -pill 5 /
-panel 0 / -window 6` (px).
- **Type scale:** `--text-sp-9 … -22` (sub-11px kept for chips/badges — note this
  is _not_ a WCAG violation; WCAG has no min font size).
- **Method/protocol colors:** `--color-method-*` / `--color-proto-*` (HTTP =
  `#2e91ff` to match the accent).

### Modern CSS / platform adoption

- **OKLCH** color (wide-gamut), **`light-dark()`** + **`color-scheme`** (single
  token block, no duplicated `.dark` token block).
- **Tailwind v4 CSS-first** (`@theme`, `@custom-variant`) — no JS config bridge.
- **Container queries** — the response panel is a `@container`; its header
  (waterfall/stats) responds to _panel_ width (`hidden @md:flex`), not viewport.
- **View Transitions API** — light/dark switch cross-fades via
  `src/lib/shared/viewTransition.ts` (`withViewTransition`), with reduced-motion
  / unsupported fallback.
- **Accessibility:** `prefers-reduced-transparency: reduce` → glass falls back to
  solid; `prefers-contrast: more` → stronger lines/text; existing
  `prefers-reduced-motion` honored. Focus is `:focus-visible` accent ring.

### Load-bearing — do NOT "modernize away"

Hash router (`createHashRouter`, required for Electron `file://`), Radix
primitives, `next-themes`, `framer-motion`. The renderer is **shared** across
web + Electron — every change here ships to desktop too.

### Known / deliberately deferred (for future correspondence)

- **WCAG 2.5.8 tap targets (24px min):** ~72 interactive `h-4`/`h-5` elements
  left compact — a deliberate tradeoff to preserve the dense layout. Revisit if
  touch/AA-strict support is needed.
- **Focus-visible audit:** a few inputs set `outline-none` with their own ring;
  a per-component pass was deferred (a blunt global override risks double-rings).
- **Method/protocol colors** are still hardcoded as hex in some components
  (ProtoChip, MethodChip, WaterfallBar) _and_ defined as tokens — unify onto the
  tokens when convenient.
- **Monaco editor** theme uses hardcoded hex (`monaco-setup.ts`) ~matching
  `--sp-code` (canvas editor can't read CSS vars at init) — keep roughly in sync
  by hand.

### Where things live

`src/styles/globals.css` (tokens, `@theme`, materials, a11y media queries),
`src/components/providers/AccentProvider.tsx` (runtime accent),
`src/components/ui/spatial/*` (Floater, chips, SubTabBar, …),
`src/components/ui/{button,input,select,textarea,dialog,…}.tsx` (primitives),
`src/lib/shared/viewTransition.ts`. See PR #230 commits for the full trail.

---

## Overview

This is a hi-fi redesign of **Restura**, a multi-protocol API client (HTTP, GraphQL, gRPC, WebSocket, SSE, MCP, Kafka) targeting both **web** and **Electron**. The design direction is called **Spatial Depth** — floating layered panels over a starlit cobalt void, with macOS-style window chrome, soft glass blurs, glowing accent highlights, and a deep dark-first palette (a fully polished light theme is also included).

The redesign covers the entire app surface: window chrome, sidebar (collections / history / workflows), tab strip, per-protocol request/response views, command palette (⌘K), settings drawer, environment switcher, console drawer, and status bar.

## About the design files

The files in this bundle are **design references created in HTML/JSX (in-browser Babel)** — interactive prototypes showing intended look, layout, and behavior. **They are not production code to copy directly.** The task is to **recreate these designs in Restura's existing codebase** (React + Electron, presumably) using its established patterns, components, and state management. If no front-end environment exists yet, React + TypeScript + Vite + Tailwind would be a sensible default.

Treat every measurement, color, font size, and spacing value here as **intentional** — but feel free to map them to the codebase's existing design tokens / component library when equivalents exist.

## Fidelity

**High-fidelity.** All colors, type sizes, spacing, border radii, shadows, and motion are pinned. Recreate pixel-perfectly using the codebase's existing libraries and patterns. The only placeholders are mock data (sample JSON, sample timing values, sample event streams).

---

## Design system / tokens

### Color — palettes

There are two palettes (`dark` and `light`), derived in `spatial/lib.jsx → makePalette(theme, accent)`. The accent color is parameterized; default is `#4d9fff` (cobalt blue). Picker offers: `#4d9fff`, `#7c5cff`, `#22c55e`, `#f59e0b`, `#ef4444`, `#06b6d4`.

#### Dark (default)

| Token        | Value                                                            | Used for                                               |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `bg`         | `#06080f`                                                        | Window background base                                 |
| `bgGlow`     | radial cobalt gradient (top-left) + violet (bottom-right) + base | Atmospheric backdrop                                   |
| `surface`    | `rgba(20,24,34,0.85)`                                            | Floating panel fill (with backdrop-filter)             |
| `surfaceHi`  | `rgba(28,33,45,0.9)`                                             | Elevated overlay (palette, drawer)                     |
| `surfaceLo`  | `rgba(14,17,24,0.7)`                                             | Inset elements (search bars, code editors backgrounds) |
| `text`       | `#eef1f9`                                                        | Primary text                                           |
| `textMuted`  | `rgba(238,241,249,0.62)`                                         | Secondary text                                         |
| `textDim`    | `rgba(238,241,249,0.36)`                                         | Tertiary / labels                                      |
| `line`       | `rgba(255,255,255,0.06)`                                         | Hairline dividers                                      |
| `lineStrong` | `rgba(255,255,255,0.12)`                                         | Stronger borders (buttons)                             |
| `accent`     | `#4d9fff`                                                        | Primary action, focus rings, links                     |
| `code`       | `#0a0d14`                                                        | Code editor background                                 |
| `hoverBg`    | `rgba(255,255,255,0.04)`                                         | Hover state on rows                                    |
| `activeBg`   | `rgba(77,159,255,0.15)`                                          | Selected row / active tab                              |

#### Light

| Token        | Value                          |
| ------------ | ------------------------------ |
| `bg`         | `#eef2fa`                      |
| `bgGlow`     | softer cobalt + violet radials |
| `surface`    | `#ffffff`                      |
| `surfaceHi`  | `#fafbfd`                      |
| `surfaceLo`  | `#f3f5f9`                      |
| `text`       | `#0e1320`                      |
| `textMuted`  | `rgba(14,19,32,0.6)`           |
| `textDim`    | `rgba(14,19,32,0.38)`          |
| `line`       | `rgba(14,19,32,0.07)`          |
| `lineStrong` | `rgba(14,19,32,0.12)`          |

### Shadows / depth

The **defining visual language** is layered depth. Every "surface" floats with the same shadow recipe:

- **Standard float (panels):**
  - Dark: `0 1px 0 rgba(255,255,255,0.05) inset, 0 12px 36px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4)`
  - Light: `0 1px 0 rgba(255,255,255,0.6) inset, 0 8px 24px rgba(20,30,60,0.08), 0 1px 3px rgba(20,30,60,0.05)`
- **Large float (response panels, drawers):**
  - Dark: `0 1px 0 rgba(255,255,255,0.06) inset, 0 24px 60px rgba(0,0,0,0.65), 0 6px 18px rgba(0,0,0,0.5)`
  - Light: `0 1px 0 rgba(255,255,255,0.6) inset, 0 20px 50px rgba(20,30,60,0.15), 0 4px 12px rgba(20,30,60,0.08)`
- **Accent glow** (active dot, accent button, ttfb bar): `0 0 8px <accent>88` or `0 0 0 1px <accent>33, 0 0 16px <accent>26`

In dark mode, panels also use `backdrop-filter: blur(24px) saturate(180%)` for the glass effect.

### Border radius

- `7px` — small inline chips (method tags, kbd, badges)
- `8–9px` — buttons, sub-tabs, segmented pickers, inline pill buttons
- `12px` — small floaters (URL bar, tab strip, connection bars)
- `14px` — large floaters (sidebar, request/response panels, drawers, palette)
- `16px` — the outer app window

### Typography

- **Sans (UI):** `Geist` (Google Fonts) — weights 400, 500, 600, 700. Fallback: `-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`
- **Mono (code, URLs, timestamps, keys, kbd):** `JetBrains Mono` — weights 400, 500, 600, 700. Fallback: `"SF Mono", Menlo, monospace`

Type scale:

| px        | weight                                 | usage                                             |
| --------- | -------------------------------------- | ------------------------------------------------- |
| 9 – 10    | 700                                    | Mini badges, partition pills                      |
| 10.5      | 700, letter-spacing 0.5–0.7, UPPERCASE | Section labels ("HEADERS", "TIMING", "STREAMING") |
| 11 – 11.5 | 500–600                                | Secondary text, hints, timestamps, kbd            |
| 12 – 12.5 | 500–600                                | Body, table cells, code blocks                    |
| 13 – 14   | 600–700                                | Tab labels, button labels, panel titles           |
| 16        | 700                                    | Drawer titles                                     |
| 22        | 700                                    | Big stat values (bento numbers, headings)         |

### Iconography

All icons are custom 14×14 (default) inline SVGs in `spatial/lib.jsx → SIcon`, 2px stroke, round line-join. Names match Lucide conventions; the codebase can drop in `lucide-react` directly with no visual change.

---

## Layout architecture

The whole app is a 1440×900 canvas that scales to fit the viewport (letterboxed on black). At small viewports it shrinks proportionally; at very large viewports it can be removed or replaced with a min-width responsive layout. **For production, treat 1440×900 as the design target and make the app responsive at that size** — drop the scaling wrapper.

### Top-down structure

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🔴🟡🟢  Restura     [ env pill (centered) ]    [Search ⌘K] [✨] [⚙]    │   ← Window chrome (44px)
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─Sidebar──┐  ┌─Tab strip────────────────────────────────────────────┐   │
│ │ Org      │  └────────────────────────────────────────────────────  │   │
│ │ Search   │                                                          │   │
│ │ Tabs     │  ┌─URL bar──────────────────────────────────[Send ⌘↵]┐ │   │
│ │ Tree     │                                                          │   │
│ │   …      │  ┌─Request panel───────┐  ┌─Response panel──────────┐   │   │
│ │ Env card │  │ Sub-tabs            │  │ Status / time / waterfall│   │   │
│ └──────────┘  │ Params editor / etc │  │ Body / Headers / Timing  │   │   │
│               └─────────────────────┘  └──────────────────────────┘   │   │
├──────────────────────────────────────────────────────────────────────────┤
│ ▼ Console  9   ● 1  ● 2  ● 5  ● 1     last: error · 14m ago             │   ← Console drawer (32 collapsed, 232 expanded)
├──────────────────────────────────────────────────────────────────────────┤
│ ● prod  ⚡ 14 requests  Auto-save        HTTP/2 · TLS 1.3  v1.4.2  ⌘K   │   ← Status bar (28px)
└──────────────────────────────────────────────────────────────────────────┘
```

### Spacing

- Outer padding around body: `0 14px 12px`
- Gap between sidebar and main column: `12px`
- Gap between vertical stack in main column (tab strip → url bar → req/res row): `10px`
- Gap between request and response panel: `10px`
- Inside panels: `12–16px` padding for most, `8–10px` for tighter rows

---

## Screens / views

### 1. Window chrome (`shell.jsx → WindowChrome`)

- **Height:** 44px. Padding `0 14px`.
- **Left:** macOS traffic lights (12px circles, gap 7) — colors `#ff5f57`, `#febc2e`, `#28c840`, each with `inset 0 0 0 0.5px rgba(0,0,0,0.15)`. Followed by "Restura" label in `textMuted`, 12px.
- **Center (absolute-positioned):** Environment pill — a small Floater with a globe icon (colored by env), the env host in `JetBrains Mono`, a `·` separator, and the env name in env's color. Click toggles the env switcher.
- **Right:** A search trigger pill (`⌘K` displayed in a kbd), then sparkle + cog icon buttons (30×30, 9-radius surfaceLo floaters).

### 2. Sidebar (`sidebar.jsx`)

- **Width:** 268px, padding 8px. Floater radius 14.
- **Order top to bottom:**
  1. Org header — 32×32 gradient avatar (`linear-gradient(135deg, accent, #a78bfa)` with `0 6px 18px accent55` glow), "Restura" / "Personal · 24 requests", `…` more icon.
  2. Quick find bar — search icon + placeholder + kbd `⌘K`. Background `surfaceLo`, 9-radius.
  3. Segmented tabs — `Collections | History | Workflows` with icons. Selected pill has surface color + subtle shadow (light) or `rgba(255,255,255,0.08)` (dark).
  4. **Content** (`flex: 1, overflow: auto`):
     - **Collections tab:** Section header ("5 collections" + `+` button). Folders with chevron + folder icon + name + count. Expanded folders show children indented to 28px; each child is a row with a `MethodChip`, the name, and a non-HTTP `ProtoChip` on the right if applicable. Active child has `activeBg`, an `accent`-colored 3×14 indicator bar at left, and a 0 0 8px accent glow on the bar.
     - **History tab:** Filter chips (All / GET / POST / Errors / Pinned). Group headers (Today / Yesterday / Earlier). Rows: method chip + a colored status code chip (green ≤299, amber ≤499, red ≥500) + truncated path in mono + ms in mono.
     - **Workflows tab:** Cards (radius 9, surfaceLo). Each card: workflow icon, name, PASS/FAIL pill, then a row of "5 steps · 12 runs · last run 14m ago", and a steps strip — N equal-width 4px-tall bars showing pass/fail per step.
  5. Env footer — small card with colored dot (with halo shadow `0 0 0 3px envColor26`), env name + host. Click opens env switcher.

### 3. Tab strip (`shell.jsx → TabStrip`)

- Floater radius 12, padding 4, gap 2, **overflow hidden** with horizontal scroll inside.
- Each tab: 7×12 padding, 9-radius. Layout: `ProtoChip` + name (max 130, ellipsis) + dirty dot (5×5 accent circle with glow) + close (×).
- Active tab: `activeBg`, inset 0 0 0 1px accent44 ring.
- A `+` button at the end (28×28, 8-radius) for new tab.

### 4. URL bar (`protocols-1.jsx → UrlBar`)

Used as the request bar across HTTP, GraphQL, gRPC, SSE.

- Outer: flex row, gap 10. Left: Floater pill containing method chip + URL + history/copy/link icons. Right: Send button.
- **Method chip:** Colored by method (see `METHOD_COL` table below). Colored background tint, mono 12/700, padding 7×14, radius 8. Has `▾` chevron at right indicating clickable picker.
- **URL field:** mono 13, with the protocol prefix (`https://`) in `textDim`, host in `text`, path segments in `textDim`, variables like `{{userId}}` highlighted with `background: rgba(245,158,11,0.2); color: #f59e0b; padding: 0 4px; border-radius: 4` (always for `{{…}}` template syntax — used everywhere in the app).
- **Send button:** 40 tall, 12-radius. Background `linear-gradient(180deg, accent, #3a85ee)`. Shadows: `0 8px 24px accent55, inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 1px accentaa`. Contents: `Send icon` + "Send" + a `⌘↵` kbd.

### Method color table

```
GET    #22c55e  / rgba(34,197,94,0.14)
POST   #f59e0b  / rgba(245,158,11,0.16)
PUT    #3b82f6  / rgba(59,130,246,0.16)
PATCH  #a855f7  / rgba(168,85,247,0.16)
DEL    #ef4444  / rgba(239,68,68,0.16)
HEAD   #06b6d4  / rgba(6,182,212,0.16)
WS     #a78bfa  / rgba(167,139,250,0.16)
SSE    #06b6d4  / rgba(6,182,212,0.16)
MCP    #f59e0b  / rgba(245,158,11,0.16)
GQL    #e879a4  / rgba(232,121,164,0.16)
```

### Protocol color (used in `ProtoChip`)

```
HTTP  #4d9fff
gRPC  #22c55e
WS    #a78bfa
GQL   #e879a4
MCP   #f59e0b
SSE   #06b6d4
Kafka #f472b6
```

### 5. HTTP view (`protocols-1.jsx → HttpView`)

The workhorse. Composition:

1. `UrlBar` (method = GET, URL = `https://api.restura.dev/v2/users/{{userId}}/orders`)
2. Two-column row:
   - **Left request panel** (Floater, flex: 1)
     - Sub-tabs: Params (3) / Headers (4) / Body / Auth `Bearer` / Scripts / Settings
     - Sub-tab tabs use a 2px accent underline with a `0 0 8px accent` glow. Inactive tabs are `textMuted`, active is `text`, bold.
     - Each sub-tab swaps body content:
       - **Params / Headers** → table of `ParamRow`s. Each row: 28 / 1fr / 1.5fr / 1fr / 22 grid. Toggle pill (24×14, accent w/ glow when on, lineStrong off), key in mono, value in mono (with `{{var}}` highlighting), description in sans 11.5 muted, close × at right. Disabled rows have 0.55 opacity. Below: `+ Add parameter`.
       - **Body** → segmented type picker (`none / JSON / form-data / x-www-form-urlencoded / GraphQL / raw / binary`), then a code editor block (gutter line numbers + syntax-highlighted JSON). Bottom strip with byte count, validity, variable list.
       - **Auth** → left column of 7 auth types (Inherit / No Auth / Bearer / Basic / API Key / OAuth 2.0 / AWS Sig v4). Right column shows the selected type's form (e.g. for Bearer: token field with variable resolution preview).
       - **Scripts** → phase toggle (pre-request / post-response) + a code editor with syntax-highlighted JS (`pm.test`, `restura.response`, etc.).
       - **Settings** → list of toggle rows (Follow redirects, Verify SSL, Encode URL, Send cookies, Save to history).
   - **Right response panel** (large Floater, flex: 1.2)
     - **Status row** (12px 16px padding, line-bottom): `StatusPill` (green for 200, with glow), `Stat` for Time / Size / HTTP, then on right "WATERFALL" label + a 220×8 horizontal stacked bar showing DNS / TCP / TLS / Request / Wait (TTFB) / Download — each segment proportional to ms, the TTFB segment gets `inset 0 0 6px accent`. Each segment colored from the timing palette.
     - **Sub-tabs:** Body / Headers (6) / Cookies / Timeline / Tests + on right a `Pretty / Raw / Preview` segmented picker + copy + download icons.
     - **Body view:** Code editor — left 40px line-number gutter (mono 11.5, tabular-nums, dim), right is preformatted highlighted JSON. Background `code`.
     - **Headers view:** Two-column grid of key (mono, muted, 200px) and value (mono, text). Each row 6 vertical padding, hairline divider.
     - **Timeline view:** Per-stage horizontal bar visualization, plus a Server-Timing summary at the bottom in surfaceLo box.
     - **Cookies / Tests:** Empty state — centered muted text.

### 6. GraphQL view (`protocols-1.jsx → GraphQLView`)

Three-column layout:

- **Schema explorer (220px):** Floater. Header with layers icon (accent), "Schema" title, green "LOADED" pill (9.5/700 letter-spaced 0.5, color `#22c55e`, background `rgba(34,197,94,0.16)`, radius 4, padding 1×5), refresh icon. Then filter input row. Then list of types: kind badge (color-coded by `OBJECT` / `ENUM`), type name in mono. Indented field list below each.
- **Query editor (flex: 1):** Large floater (background `code`). Sub-tab bar: Query / Variables (2) / Headers (3) with right-side helpers (Prettify, SDL, byte count). Body = syntax-highlighted GraphQL query. Below a divider, a Variables strip with a chevron, "Variables · valid" tag, and the variables JSON syntax-highlighted.
- **Response (flex: 1):** Large floater (background `code`). Header with `StatusPill 200`, `Stat` time/size, copy/download. Body = syntax-highlighted JSON response.

GraphQL syntax highlight rules (in `hlGraphQL`):

- Keywords (`query|mutation|subscription|fragment|on`) → `#c792ea`
- Variables (`$foo`) → `#ffab70`
- Types (`CapsCase`) → `#79b8ff`
- Comments (`# …`) → `#64748b` italic

### 7. gRPC view (`protocols-1.jsx → GrpcView`)

Three columns:

- **Service tree (280px):** Header row with bolt icon (green), "Reflection" + "READY" pill. Below: `4 services · 18 methods` in mono. Then list of services (chevron + name + method count). Expanding shows methods with a small kind badge (U/S/C/B for unary/server/client/bidi) and a name. Active method gets `activeBg` + accent left bar with glow. Bottom: "Upload .proto" button (full-width, lineStrong border, transparent).
- **Center column:** Method invocation bar (Unary picker + URL + Invoke button), then method context card (`UnaryEcho` in accent mono, "Single request, single response", `in EchoRequest → out EchoReply`, "Show schema" link). Below, the request body editor with sub-tabs (Message / Metadata (3) / Auth / Settings / Scripts).
- **Response (flex: 1.1):** Header with "OK · 0" pill, time stat. Body = mono JSON. Below in own section: "Trailers" key-value grid (grpc-status, grpc-message, x-server-trace, content-type). Footer with size / frames / compression stats.

### 8. WebSocket view (`protocols-2.jsx → WebSocketView`)

- **Connection bar:** WS chip (purple) + URL + `CONNECTED` glow pill + Disconnect button (red outline).
- **Stats row:** uptime / ↑ / ↓ / latency / protocol stats + an "auto-reconnect" toggle.
- **Two columns:**
  - **Event log (flex: 1.4):** Floater with header (Messages / count / search / filter dropdown / download / trash). Column header strip ("DIR / TIME / SIZE / PREVIEW", 9.5/700 letter-spaced). Rows: dir tag (`← rx` green / `→ tx` purple, mono bold), ts (mono muted), size (dim), highlighted JSON preview (ellipsis). Selected row has `activeBg` + 2px accent left border.
  - **Right column** (two stacked floaters):
    - "Selected message" — full syntax-highlighted JSON.
    - "Compose" — format tabs (json / text / binary), code editor, Send button with `⌘↵` kbd + byte counter.

### 9. SSE view (`protocols-2.jsx → SSEView`)

- `UrlBar` (method = `SSE`, Stream button)
- **Stats row:** STREAMING (green) / EVENTS / LAST-EVENT-ID / AVG GAP / RECONNECT + Stop button.
- **Two columns:**
  - **Event timeline (flex: 1.4):** Vertical timeline rail (1px line at x=96). Each event row: ts (mono right-aligned), a 9×9 colored dot with halo ring (`0 0 0 2px surface, 0 0 8px color88`), event-type pill (colored by `message / progress / token / done`), id, data (mono ellipsis). Legend in header.
  - **Right column:**
    - "Assembled output" — typed text with a blinking accent cursor (`background: accent33, border-right: 2px solid accent, animation: blink 1s infinite`). Progress bar gradient `accent → #a78bfa`. Phase list under it.
    - "Counters" — 2×2 grid of stat tiles (Events / Bytes / Tokens / Reconnects).

### 10. MCP view (`protocols-2.jsx → MCPView`)

- **Connection bar:** MCP chip + URL + Streamable HTTP picker pill + CONNECTED pill + Reconnect button.
- **Three columns:**
  - **Tools/Resources/Prompts/Log tabs + tools list (300px):** Each tool row shows sparkle icon (amber/accent), tool name in mono bold, args count on right; under that, a description in muted. Selected tool gets `activeBg` + 1px accent55 border.
  - **Invoke form (flex: 1):** Tool name in accent mono + Invoke button (small accent button with play icon). Body = stacked argument fields. Each field: name in mono / type in mono dim / `required` label if so / value box in mono inside a surfaceLo container.
  - **Result (flex: 1, background `code`):** Header with "Result" + `isError: false` pill + time + size stats. Body = syntax-highlighted JSON content.

### 11. Kafka view (`protocols-2.jsx → KafkaView`)

- **Connection bar:** Kafka chip (pink) + cluster URL + topic name in accent pink + Consume mode picker + SUBSCRIBED pill + Pause button.
- **Stats row:** PARTITIONS / CONSUMER ID / LAG (green when 0) / OFFSET RESET / MSG/SEC + per-partition pills (`P0 8423`, `P1 5109`, `P2 2285`) each colored differently.
- **Two columns:**
  - **Message log (flex: 1.6):** 5-col grid (40 / 80 / 110 / 130 / 1fr) — PART / OFFSET / TIME / KEY / VALUE. PART is a colored mini pill (per-partition color). Selected row gets `activeBg` + accent left border.
  - **Detail panel:** Header "Message · P0 / 8422", a "Headers" key-value section, then syntax-highlighted JSON.

### 12. Command palette (`overlays.jsx → CommandPalette`)

- **Overlay:** Full-screen scrim `rgba(0,0,0,0.55)` (dark) / `rgba(0,0,0,0.25)` (light), `backdrop-filter: blur(6px)`. Positioned with `paddingTop: 100`, content top-centered.
- **Card:** 640px wide, max-height 480. `surfaceHi` background, `lineStrong` border, large shadow, `backdrop-filter: blur(40px) saturate(180%)`.
- **Header:** Search icon (15) + autofocused input (Geist 14) + `ESC` kbd. 14×16 padding, line-bottom.
- **Groups (Requests / Actions / New / Settings):** Each group has a 10/700 letter-spaced uppercase label. Items have: method chip (if request) / proto chip (if new) / icon (if action/settings) / name (text, nowrap) / path (textDim 11, ellipsis) / `RECENT` pill (if recent) / right-aligned shortcut kbd.
- **Highlighted row:** `activeBg`, 2px accent left border. Mouse hover and arrow-key navigation both update the highlighted row.
- **Footer:** `↑↓ navigate / ↵ select / ⌘↵ in new tab` + N results — small kbds.
- **Behavior:**
  - Toggled by ⌘K (or Ctrl+K)
  - Esc closes, ↑/↓ navigate, ↵ selects and closes
  - Filtering matches name OR path (case-insensitive substring)
  - Empty results show "No matches for '<q>'" muted centered.

### 13. Settings drawer (`overlays.jsx → SettingsDrawer`)

- **Layout:** Right-side drawer. 760px wide, full height. `surfaceHi`, `lineStrong` left border, `-30px 0 80px rgba(0,0,0,0.5)` shadow.
- **Animation:** Slides in from right — `animation: slideIn .25s cubic-bezier(.2,.7,.3,1)` (already defined in Spatial.html).
- **Header:** Cog icon + "Settings" title (16/700) + close × on right (30×30 surfaceLo).
- **Two columns:** 220px nav rail (vertical list of 8 sections: General / Appearance / Requests / Proxy / Certificates / Secrets / Shortcuts / About), each row 8×10, 8-radius, with icon + label. Active section gets `activeBg`.
- **Section content (right, scrollable):** Each section uses:
  - `H1` — 22/700 heading
  - `SectionLabel` — 11/700 letter-spaced uppercase dim
  - `FieldRow` — 1fr/auto grid, label in 13/600 + hint in 11.5 muted underneath, control on right, separated by hairline.
  - Controls: `ToggleField` (36×22 toggle pill), `Segmented` (radio pills inside surfaceLo container), `Stepper` (mono value + up/down chevrons), `TextField` (mono value in surfaceLo).

Triggered by ⌘, or the cog icon in chrome.

### 14. Env switcher (`overlays.jsx → EnvSwitcher`)

- Anchored popover at bottom-left of viewport (above the env footer in sidebar). 320px wide, 14-radius, `surfaceHi`.
- Header: 11/700 letter-spaced "Switch environment".
- Rows: colored dot (with halo) + env name + host/vars subtitle (mono, 10.5). Active env: `activeBg` + 2px accent left border + check icon.
- Footer: "+ New environment" row.

### 15. Console drawer (`shell.jsx → ConsoleDrawer`)

Collapsible bar at bottom of body (above status bar).

- **Collapsed (32 tall):** Chevron + "Console" label (10.5/700 letter-spaced) + total count chip + per-level counters (color dot + count for error / warn / info / debug) + on right "last: error · 14m ago" muted.
- **Expanded (32 header + 200 body):** Header gains filter row (`all / error / warn / info / debug`) + download + trash icons.
- **Body:** Mono 11.5, grid `110 / 60 / 70 / 1fr` per row — ts / LEVEL (colored 10/700) / [src] (muted) / msg with inline highlighting (timing in accent, status codes colored, `{{vars}}` amber, ✓ green).

Level colors: `info #06b6d4 · debug #94a3b8 · warn #f59e0b · error #ef4444`.

### 16. Status bar (`shell.jsx → StatusBar`)

- **Height:** 28px. Padding `0 16px`. Hairline top.
- **Left:** Env dot with glow + env name. Then ⚡ icon + "14 requests". Then "Auto-save".
- **Right:** "HTTP/2 · TLS 1.3" / "v1.4.2" / `⌘K` kbd + "Palette".
- All text muted 11.

---

## Interactions

### Keyboard shortcuts (handled globally in `shell.jsx → App` and `overlays.jsx → CommandPalette`)

| Shortcut                      | Action                           |
| ----------------------------- | -------------------------------- |
| `⌘K` / `Ctrl+K`               | Toggle command palette           |
| `⌘,` / `Ctrl+,`               | Open settings drawer             |
| `Esc`                         | Close palette / drawer / popover |
| `↑ / ↓` (in palette)          | Navigate items                   |
| `↵` (in palette)              | Select and close                 |
| `⌘↵` (planned in send button) | Send current request             |

### Mouse / click

- **Sidebar request rows** → opens a new tab (or focuses an existing tab for that request). Tab state stored in `tabs` array; switching is via `tabs.map(t => ({...t, active: t.id === id}))`.
- **Tab close (×)** → removes tab; if active, falls back to previous tab. `e.stopPropagation()` to avoid triggering tab select.
- **Tab `+`** → creates a new HTTP GET tab.
- **Sub-tabs** → live `useState` swap inside each protocol view.
- **Sidebar segmented tabs** → swaps Collections / History / Workflows view.
- **Folder rows** → toggles expanded state (controlled in `CollectionsView`).
- **Env footer** → opens `EnvSwitcher` popover (closes on outside click).
- **Console header** → toggles expanded state.
- **Command palette rows** → mouse-enter highlights (synced with arrow-key index); click selects & closes.

### Motion / transitions

- **Toggle pills** — `transition: transform .15s, background .15s`
- **Tab strip hovers / sub-tab indicator** — no explicit duration, default browser
- **Settings drawer** — `slideIn .25s cubic-bezier(.2,.7,.3,1)` (from `transform: translateX(40px) opacity 0`)
- **SSE assembled-output cursor** — `blink 1s infinite` (already defined)
- **Folder chevron rotation** — `transition: transform .12s`

No fancy spring animations. Keep transitions short, ~120–250ms, ease-out.

---

## State

A real implementation should split into roughly these slices (e.g. Zustand / Redux / React context):

```ts
type AppState = {
  // Persisted (localStorage / sqlite-backed in Electron)
  workspace: { id, name, ... };
  collections: Collection[];
  history: HistoryEntry[];        // capped at maxHistory setting
  workflows: Workflow[];
  environments: Environment[];
  activeEnvId: string;
  settings: Settings;             // theme, accent, density, font, intensities, shortcuts

  // Session
  tabs: OpenTab[];                // each refs a collection request OR is unsaved
  activeTabId: string;
  sidebarTab: 'collections' | 'history' | 'workflows';
  paletteOpen: boolean;
  settingsOpen: boolean;
  envSwitcherOpen: boolean;
  consoleOpen: boolean;
  consoleLogs: LogEntry[];        // append-only ring buffer

  // Per-tab (keyed by tabId)
  tabState: Record<TabId, {
    subTab: string;
    method: HttpMethod;
    url: string;
    params: KvRow[];
    headers: KvRow[];
    body: { type: BodyType; value: string };
    auth: AuthConfig;
    scripts: { pre: string; post: string };
    settings: RequestSettings;
    response?: Response;            // last response
    sending: boolean;
    abortController?: AbortController;
  }>;
};
```

The Tweaks panel writes to `settings` (which is what `useTweaks` is faking in the prototype).

---

## Files in this bundle

- `Spatial.html` — entry HTML. Loads React 18, Babel standalone (in-browser JSX), Geist + JetBrains Mono from Google Fonts.
- `spatial/lib.jsx` — palettes, `Floater`, `SIcon` (all SVG icons), `MethodChip`, `ProtoChip`, `Kbd`, `StatusPill`, `Stat`, JSON/GraphQL syntax highlighters, mock `DATA`.
- `spatial/sidebar.jsx` — `Sidebar` + `CollectionsView` + `HistoryView` + `WorkflowsView`.
- `spatial/protocols-1.jsx` — `UrlBar`, `ResponsePanel`, `SubTabBar`, `ParamRow`, `HttpView`, `GraphQLView`, `GrpcView`.
- `spatial/protocols-2.jsx` — `WebSocketView`, `SSEView`, `MCPView`, `KafkaView`.
- `spatial/overlays.jsx` — `CommandPalette`, `SettingsDrawer`, `EnvSwitcher`.
- `spatial/shell.jsx` — `App` (main composition + global state + shortcuts), `WindowChrome`, `TabStrip`, `ConsoleDrawer`, `StatusBar`, `Stage` (viewport scaler — drop in production).
- `tweaks-panel.jsx` — In-prototype tweak panel (Mode / Accent / Sidebar position / Density / Star field toggle / Glass intensity slider). **Not part of the shipping app** — it's a design-time control. The values it sets should map onto your real settings store.

## Assets

No images, no icons-as-image files. **All icons are inline SVG** — directly portable to Lucide or any icon library. The Geist + JetBrains Mono fonts are loaded from Google Fonts.

## Notes for implementation

- **Window chrome** is design-time. In Electron, use `titleBarStyle: 'hiddenInset'` and overlay the env pill with `WebkitAppRegion: drag` on empty areas. On web, drop the traffic lights and let the browser chrome handle it.
- The **Tweaks panel** is a prototype concern only — don't ship it. Its functionality (accent picker, theme toggle, density) belongs in the real Settings → Appearance.
- The **`Stage` component** in `shell.jsx` exists only to scale the design to fit a preview iframe. For production, remove it and let the app fill the window naturally; instead make the inner content responsive (the design works down to ~1200px; below that, collapse sidebar to an icon rail).
- For **variable highlighting** (`{{var}}`): treat `{{[a-zA-Z_]+}}` as a recognizable token. In an editor, you'd want resolved-value tooltips on hover and click-to-jump-to-environment editor.
- For **syntax highlighting** of JSON / GraphQL / JS, in production switch to **Shiki** or **Monaco** rather than the regex highlighter used here.
- **Mock data** in `lib.jsx → DATA` is illustrative only; replace with real collection / request / response models.
- The design assumes you can hit `claude-haiku` or similar for AI assists (the sparkle icon in the chrome — currently a no-op).

If you're starting from a blank Restura codebase, the recommended stack is **React + TypeScript + Vite + Zustand + Lucide-icons + Shiki**, with **Electron** as the desktop shell and a **Rust** core for the actual request engine (gRPC reflection, WS upgrade, Kafka client, etc.).
