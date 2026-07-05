# Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2018-line `SettingsDrawer.tsx` monolith with a full-page `/settings/:sectionId` route — persistent sidebar with search, one file per section under a new `src/features/settings/` module — matching the approved design in `docs/superpowers/specs/2026-07-05-settings-redesign-design.md`.

**Architecture:** Extract each of the 11 existing sections verbatim (behavior unchanged) into `src/features/settings/sections/*.tsx`, promote the shared `SectionHeader`/`SectionLabel`/`FieldGroup`/`FieldRow`/`DataButton` helpers into `src/features/settings/components/`, build a new `SettingsSidebar` + `SettingsSearch` for navigation, and a `SettingsPage` route shell that replaces the old dialog. Cut over all four existing trigger call sites to `navigate()`, delete the monolith, and land an equivalent-or-better test suite.

**Tech Stack:** React 19, TypeScript (strict, `noUncheckedIndexedAccess`), React Router v7 (`createHashRouter`), Zustand (`useSettingsStore`, unchanged), Vitest + React Testing Library, existing `@/components/ui/spatial` kit (`Floater`, `Segmented`, `Stepper`, `TextField`, `ToggleField`, `Kbd`, `SubTabPanel`).

## Global Constraints

- Platform: shared renderer — every new file must work identically on web and Electron; only capability gates (`isElectron()`, `ai.*` flags) may branch behavior, never the visual system.
- No new design tokens. Only the existing Spatial Depth tokens/classes (`sp-floater`, `sp-inset`, `--sp-accent`, `rounded-sp-*`) and the existing `@/components/ui/spatial` kit.
- Sidebar surface is flat `.sp-floater` (not frosted `.sp-floater-lg`) per the codebase's documented "pro instrument density" convention — see spec §5 and its amendment.
- `useSettingsStore.ts` (Zustand + persist + Zod) is **not modified**. Only new transient (non-persisted) UI state (search query, active section from URL) is added, and it lives in `SettingsPage.tsx` / `SettingsSidebar.tsx`, never in the store.
- Judge/scorer settings move from Requests into AI (spec §6) — this is the only content reorganization; every other section is a like-for-like move.
- `capabilities.ts` is unchanged — this is a presentation-layer redesign, not a capability change.
- `SettingsDrawer.tsx` and its test are deleted once the replacement is verified — this is a cutover, not an additive change (spec §11).
- Every new component file gets full TypeScript types; no `any`. Match strict-mode settings already in effect (`noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes` is off project-wide).

---

## Reference: current source

All code in this plan is extracted from `src/components/shared/SettingsDrawer.tsx` (2018 lines, read in full during planning) and `src/routes/index.tsx` / `src/App.tsx` (trigger + router wiring). Section line numbers below refer to that file as it exists today, before any edits in this plan.

---

### Task 1: Section registry + shared field primitives + DataButton

**Files:**

- Create: `src/features/settings/lib/sectionRegistry.ts`
- Create: `src/features/settings/components/FieldPrimitives.tsx`
- Create: `src/features/settings/components/DataButton.tsx`
- Test: `src/features/settings/lib/__tests__/sectionRegistry.test.ts`

**Interfaces:**

- Produces: `SectionId` type, `SectionDef` interface, `SECTIONS: SectionDef[]`, `filterSections(query: string, sections: SectionDef[]): SectionDef[]` from `sectionRegistry.ts`.
- Produces: `SectionHeader`, `SectionLabel`, `FieldGroup`, `FieldRow` (props unchanged from the monolith) from `FieldPrimitives.tsx`.
- Produces: `DataButton` (props unchanged) from `DataButton.tsx`.
- Consumes: nothing new — `Floater` from `@/components/ui/spatial`, `cn` from `@/lib/shared/utils`, icons from `lucide-react`.

- [ ] **Step 1: Write the failing test for `filterSections`**

```ts
// src/features/settings/lib/__tests__/sectionRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { SECTIONS, filterSections } from '../sectionRegistry';

describe('sectionRegistry', () => {
  it('exports exactly the 11 existing sections', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'appearance',
      'requests',
      'proxy',
      'certificates',
      'secrets',
      'ai',
      'data',
      'updates',
      'shortcuts',
      'about',
    ]);
  });

  it('filterSections matches by title', () => {
    const result = filterSections('proxy', SECTIONS);
    expect(result.map((s) => s.id)).toEqual(['proxy']);
  });

  it('filterSections matches by keyword, case-insensitively', () => {
    const result = filterSections('MTLS', SECTIONS);
    expect(result.map((s) => s.id)).toEqual(['certificates']);
  });

  it('filterSections returns every section for an empty query', () => {
    expect(filterSections('', SECTIONS)).toHaveLength(SECTIONS.length);
  });

  it('filterSections returns an empty array when nothing matches', () => {
    expect(filterSections('xyzzy-no-match', SECTIONS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/lib/__tests__/sectionRegistry.test.ts`
Expected: FAIL — `Cannot find module '../sectionRegistry'`

- [ ] **Step 3: Implement `sectionRegistry.ts`**

```ts
// src/features/settings/lib/sectionRegistry.ts
import {
  Database,
  Download,
  Info,
  KeyRound,
  Keyboard as KeyboardIcon,
  Network,
  Palette,
  Send,
  ShieldCheck,
  Sliders,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export type SectionId =
  | 'general'
  | 'appearance'
  | 'requests'
  | 'proxy'
  | 'certificates'
  | 'secrets'
  | 'ai'
  | 'data'
  | 'updates'
  | 'shortcuts'
  | 'about';

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Extra terms `filterSections` matches against, beyond the label itself. */
  keywords: string[];
}

export const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: Sliders,
    keywords: ['theme', 'layout', 'history', 'telemetry'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    keywords: ['accent', 'color', 'dark mode', 'light mode'],
  },
  {
    id: 'requests',
    label: 'Requests',
    icon: Send,
    keywords: ['timeout', 'redirect', 'tls', 'cookie', 'ssl'],
  },
  {
    id: 'proxy',
    label: 'Proxy',
    icon: Network,
    keywords: ['socks', 'pac', 'http proxy', 'socks4', 'socks5'],
  },
  {
    id: 'certificates',
    label: 'Certificates',
    icon: ShieldCheck,
    keywords: ['mtls', 'ca', 'client cert', 'custom ca', 'pem'],
  },
  {
    id: 'secrets',
    label: 'Secrets',
    icon: KeyRound,
    keywords: ['keychain', 'vault', 'handle', 'token'],
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Sparkles,
    keywords: ['provider', 'api key', 'model', 'judge', 'scorer', 'openai', 'anthropic'],
  },
  {
    id: 'data',
    label: 'Data',
    icon: Database,
    keywords: ['export', 'import', 'backup', 'clear', 'wipe'],
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: Download,
    keywords: ['version', 'release', 'auto-update', 'channel'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: KeyboardIcon,
    keywords: ['keyboard', 'keybinding', 'hotkey'],
  },
  { id: 'about', label: 'About', icon: Info, keywords: ['version', 'license', 'author', 'github'] },
];

/**
 * Section-level fuzzy search (spec §7): case-insensitive substring match
 * against the label plus each section's curated keyword list. Field-level
 * search is out of scope for this pass.
 */
export function filterSections(query: string, sections: SectionDef[]): SectionDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections.filter(
    (s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.toLowerCase().includes(q))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/lib/__tests__/sectionRegistry.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Implement `FieldPrimitives.tsx`** (moved verbatim from `SettingsDrawer.tsx:307-376`)

```tsx
// src/features/settings/components/FieldPrimitives.tsx
import * as React from 'react';
import { Floater } from '@/components/ui/spatial';
import type { LucideIcon } from 'lucide-react';

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
}

export function SectionHeader({ icon: Icon, title, description }: SectionHeaderProps) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center size-9 rounded-sp-btn border border-sp-line"
        style={{
          background:
            'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <Icon size={16} className="text-sp-accent" />
      </div>
      <div className="min-w-0">
        <h1 className="text-sp-22 font-bold text-sp-text leading-tight">{title}</h1>
        <p className="text-sp-13 text-sp-muted mt-0.5">{description}</p>
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sp-label mt-6 mb-2">{children}</div>;
}

interface FieldGroupProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Frames a labelled cluster of FieldRows in a Floater so the eye reads each
 * settings group as one card. Removes the visual noise of free-floating
 * border-bottom dividers between unrelated rows.
 */
export function FieldGroup({ label, children }: FieldGroupProps) {
  return (
    <section className="mt-5 first:mt-0">
      <SectionLabel>{label}</SectionLabel>
      <Floater radius="panel" elevation="inset" className="px-4 divide-y divide-sp-line">
        {children}
      </Floater>
    </section>
  );
}

interface FieldRowProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  control: React.ReactNode;
}

export function FieldRow({ label, hint, control }: FieldRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        {hint && <div className="text-sp-11-5 text-sp-muted mt-0.5">{hint}</div>}
      </div>
      <div className="justify-self-end">{control}</div>
    </div>
  );
}
```

- [ ] **Step 6: Implement `DataButton.tsx`** (moved verbatim from `SettingsDrawer.tsx:1467-1499`; shared by `DataSection` and `AiSection`'s Judge fields)

```tsx
// src/features/settings/components/DataButton.tsx
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

/** Pill button matching the settings pages' other inline actions. */
export function DataButton({
  onClick,
  disabled,
  icon: Icon,
  danger,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn text-sp-12 font-medium border',
        'transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        danger
          ? 'border-rose-500/30 bg-rose-500/5 text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 hover:border-rose-400/60'
          : 'border-sp-line bg-sp-surface text-sp-text hover:bg-sp-hover'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </button>
  );
}
```

- [ ] **Step 7: Type-check and commit**

Run: `npm run type-check`
Expected: no new errors

```bash
git add src/features/settings/lib/sectionRegistry.ts \
  src/features/settings/lib/__tests__/sectionRegistry.test.ts \
  src/features/settings/components/FieldPrimitives.tsx \
  src/features/settings/components/DataButton.tsx
git commit -m "feat(settings): add section registry and shared field primitives"
```

---

### Task 2: General + Appearance sections

**Files:**

- Create: `src/features/settings/sections/GeneralSection.tsx`
- Create: `src/features/settings/sections/AppearanceSection.tsx`
- Test: `src/features/settings/sections/__tests__/GeneralSection.test.tsx`
- Test: `src/features/settings/sections/__tests__/AppearanceSection.test.tsx`

**Interfaces:**

- Consumes: `SectionHeader`, `FieldGroup`, `FieldRow` from `../components/FieldPrimitives` (Task 1).
- Produces: default-exported `GeneralSection`, `AppearanceSection` components (no props).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/features/settings/sections/__tests__/GeneralSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { GeneralSection } from '../GeneralSection';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

describe('GeneralSection', () => {
  it('renders the General heading and theme control', () => {
    render(<GeneralSection />);
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText('Auto-save history')).toBeInTheDocument();
  });
});
```

```tsx
// src/features/settings/sections/__tests__/AppearanceSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { AppearanceSection } from '../AppearanceSection';
import { useSettingsStore } from '@/store/useSettingsStore';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

describe('AppearanceSection', () => {
  it('clicking an accent preset updates the settings store', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const amber = screen.getByRole('button', { name: /accent #f59e0b/i });
    await user.click(amber);
    expect(useSettingsStore.getState().settings.accent).toBe('#f59e0b');
  });

  it('active preset reports aria-pressed=true', () => {
    useSettingsStore.getState().updateSettings({ accent: '#22c55e' });
    render(<AppearanceSection />);
    expect(screen.getByRole('button', { name: /accent #22c55e/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/settings/sections/__tests__/GeneralSection.test.tsx src/features/settings/sections/__tests__/AppearanceSection.test.tsx`
Expected: FAIL — modules don't exist yet

- [ ] **Step 3: Implement `GeneralSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:382-463`, named export added)

```tsx
// src/features/settings/sections/GeneralSection.tsx
import { Sliders } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Segmented, ToggleField } from '@/components/ui/spatial';
import { withViewTransition } from '@/lib/shared/viewTransition';
import { useSettingsStore } from '@/store/useSettingsStore';
import { FieldGroup, FieldRow, SectionHeader } from '../components/FieldPrimitives';

export function GeneralSection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { theme, setTheme } = useTheme();

  const currentTheme = (theme ?? settings.theme ?? 'system') as 'light' | 'dark' | 'system';

  return (
    <>
      <SectionHeader
        icon={Sliders}
        title="General"
        description="Workspace defaults that apply to every request."
      />

      <FieldGroup label="Appearance">
        <FieldRow
          label="Theme"
          hint="Choose how Restura looks. System follows your OS preference."
          control={
            <Segmented<'light' | 'dark' | 'system'>
              value={currentTheme}
              onChange={(v) => {
                withViewTransition(() => {
                  setTheme(v);
                  updateSettings({ theme: v });
                });
              }}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ]}
            />
          }
        />
        <FieldRow
          label="Layout orientation"
          hint="Side-by-side or stacked request/response."
          control={
            <Segmented<'vertical' | 'horizontal'>
              value={settings.layoutOrientation ?? 'horizontal'}
              onChange={(v) => updateSettings({ layoutOrientation: v })}
              options={[
                { value: 'horizontal', label: 'Horizontal' },
                { value: 'vertical', label: 'Vertical' },
              ]}
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="History">
        <FieldRow
          label="Auto-save history"
          hint="Automatically record every executed request."
          control={
            <ToggleField
              checked={settings.autoSaveHistory ?? true}
              onChange={(v) => updateSettings({ autoSaveHistory: v })}
              ariaLabel="Auto-save history"
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="Privacy">
        <FieldRow
          label="Send crash & error reports"
          hint="Helps fix bugs. Only the error message, stack, app version, and browser/OS info are sent — never request payloads, URLs, headers, or response bodies."
          control={
            <ToggleField
              checked={settings.telemetry?.errorsEnabled ?? true}
              onChange={(v) => updateSettings({ telemetry: { errorsEnabled: v } })}
              ariaLabel="Send crash and error reports"
            />
          }
        />
      </FieldGroup>
    </>
  );
}

export default GeneralSection;
```

- [ ] **Step 4: Implement `AppearanceSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:469-547`)

```tsx
// src/features/settings/sections/AppearanceSection.tsx
import { Check, Palette } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Floater, Segmented } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { withViewTransition } from '@/lib/shared/viewTransition';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SPATIAL_ACCENT_PRESETS, type SpatialAccent } from '@/types';
import { FieldGroup, FieldRow, SectionHeader, SectionLabel } from '../components/FieldPrimitives';

export function AppearanceSection() {
  const accent = useSettingsStore((s) => s.settings.accent ?? '#2e91ff');
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { theme, setTheme } = useTheme();
  const currentTheme = (theme ?? 'system') as 'light' | 'dark' | 'system';

  return (
    <>
      <SectionHeader
        icon={Palette}
        title="Appearance"
        description="Pick your accent color and theme."
      />

      <section className="mt-5 first:mt-0">
        <SectionLabel>Accent</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4">
          <div className="text-sp-13 font-semibold text-sp-text mb-1">Accent color</div>
          <div className="text-sp-11-5 text-sp-muted mb-4">
            Used for active highlights, focus rings, and the Send button.
          </div>
          <div className="flex items-center gap-3">
            {SPATIAL_ACCENT_PRESETS.map((preset) => {
              const isActive = preset === accent;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Accent ${preset}`}
                  aria-pressed={isActive}
                  onClick={() => updateSettings({ accent: preset as SpatialAccent })}
                  className={cn(
                    'relative inline-flex items-center justify-center',
                    'w-8 h-8 rounded-full border border-sp-line transition-all',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                    isActive && 'scale-110'
                  )}
                  style={{
                    background: preset,
                    boxShadow: isActive
                      ? `0 0 0 2px var(--sp-surface-hi), 0 0 0 4px ${preset}, 0 0 16px ${preset}66`
                      : 'inset 0 1px 0 rgba(255,255,255,0.2)',
                  }}
                >
                  {isActive && <Check size={14} className="text-white drop-shadow" />}
                </button>
              );
            })}
          </div>
        </Floater>
      </section>

      <FieldGroup label="Theme">
        <FieldRow
          label="Color scheme"
          hint="Dark mode applies the full Spatial Depth glass palette."
          control={
            <Segmented<'light' | 'dark' | 'system'>
              value={currentTheme}
              onChange={(v) =>
                withViewTransition(() => {
                  setTheme(v);
                  updateSettings({ theme: v });
                })
              }
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ]}
            />
          }
        />
      </FieldGroup>
    </>
  );
}

export default AppearanceSection;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/sections/__tests__/GeneralSection.test.tsx src/features/settings/sections/__tests__/AppearanceSection.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/sections/GeneralSection.tsx \
  src/features/settings/sections/AppearanceSection.tsx \
  src/features/settings/sections/__tests__/GeneralSection.test.tsx \
  src/features/settings/sections/__tests__/AppearanceSection.test.tsx
git commit -m "feat(settings): extract General and Appearance sections"
```

---

### Task 3: Proxy + Shortcuts sections

**Files:**

- Create: `src/features/settings/sections/ProxySection.tsx`
- Create: `src/features/settings/sections/ShortcutsSection.tsx`
- Test: `src/features/settings/sections/__tests__/ProxySection.test.tsx`
- Test: `src/features/settings/sections/__tests__/ShortcutsSection.test.tsx`

**Interfaces:**

- Consumes: `FieldGroup`, `FieldRow`, `SectionHeader`, `SectionLabel` from `../components/FieldPrimitives` (Task 1).
- Produces: default-exported `ProxySection`, `ShortcutsSection`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/features/settings/sections/__tests__/ProxySection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProxySection } from '../ProxySection';

describe('ProxySection', () => {
  it('renders the Proxy heading and enable toggle', () => {
    render(<ProxySection />);
    expect(screen.getByRole('heading', { name: 'Proxy' })).toBeInTheDocument();
    expect(screen.getByText('Enable proxy')).toBeInTheDocument();
  });
});
```

```tsx
// src/features/settings/sections/__tests__/ShortcutsSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShortcutsSection } from '../ShortcutsSection';

describe('ShortcutsSection', () => {
  it('renders the Shortcuts heading and the command-palette binding', () => {
    render(<ShortcutsSection />);
    expect(screen.getByRole('heading', { name: 'Shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Open command palette')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/settings/sections/__tests__/ProxySection.test.tsx src/features/settings/sections/__tests__/ShortcutsSection.test.tsx`
Expected: FAIL — modules don't exist yet

- [ ] **Step 3: Implement `ProxySection.tsx`** (moved verbatim from `SettingsDrawer.tsx:767-838`)

```tsx
// src/features/settings/sections/ProxySection.tsx
import { Network } from 'lucide-react';
import { Segmented, Stepper, TextField, ToggleField } from '@/components/ui/spatial';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ProxyType } from '@/types';
import { FieldGroup, FieldRow, SectionHeader } from '../components/FieldPrimitives';

export function ProxySection() {
  const settings = useSettingsStore((s) => s.settings);
  const setProxyEnabled = useSettingsStore((s) => s.setProxyEnabled);
  const updateProxy = useSettingsStore((s) => s.updateProxy);

  return (
    <>
      <SectionHeader
        icon={Network}
        title="Proxy"
        description="Route outgoing requests through an HTTP(S) or SOCKS proxy."
      />

      <FieldGroup label="Outbound proxy">
        <FieldRow
          label="Enable proxy"
          hint="When off, requests go directly to the upstream host."
          control={
            <ToggleField
              checked={settings.proxy.enabled}
              onChange={setProxyEnabled}
              ariaLabel="Enable proxy"
            />
          }
        />
        <FieldRow
          label="Type"
          hint="HTTP(S) proxies tunnel via CONNECT; SOCKS4/5 open a raw TCP tunnel."
          control={
            <Segmented<Exclude<ProxyType, 'none'>>
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS' },
                { value: 'socks4', label: 'SOCKS4' },
                { value: 'socks5', label: 'SOCKS5' },
              ]}
              value={settings.proxy.type === 'none' ? 'http' : settings.proxy.type}
              onChange={(type) => updateProxy({ type })}
              size="sm"
              ariaLabel="Proxy type"
            />
          }
        />
        <FieldRow
          label="Host"
          control={
            <TextField
              mono
              placeholder="proxy.example.com"
              value={settings.proxy.host}
              onChange={(e) => updateProxy({ host: e.target.value })}
              disabled={!settings.proxy.enabled}
              className="w-[260px]"
            />
          }
        />
        <FieldRow
          label="Port"
          control={
            <Stepper
              value={settings.proxy.port}
              onChange={(v) => updateProxy({ port: v })}
              min={1}
              max={65535}
              ariaLabel="Proxy port"
            />
          }
        />
      </FieldGroup>
    </>
  );
}

export default ProxySection;
```

- [ ] **Step 4: Implement `ShortcutsSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:96-140,1673-1720`)

```tsx
// src/features/settings/sections/ShortcutsSection.tsx
import { Keyboard as KeyboardIcon } from 'lucide-react';
import { Kbd, Floater } from '@/components/ui/spatial';
import { SectionHeader, SectionLabel } from '../components/FieldPrimitives';

const SHORTCUT_GROUPS: Array<{
  title: string;
  shortcuts: Array<{ keys: string[]; description: string }>;
}> = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open command palette' },
      { keys: ['⌘', '/'], description: 'Show keyboard shortcuts' },
      { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
      { keys: ['⌘', ','], description: 'Open settings' },
      { keys: ['⌘', 'N'], description: 'New request' },
    ],
  },
  {
    title: 'Request Builder',
    shortcuts: [
      { keys: ['⌘', '↵'], description: 'Send request' },
      { keys: ['⌘', 'S'], description: 'Save request to collection' },
      { keys: ['⌥', '1'], description: 'Switch to Params tab' },
      { keys: ['⌥', '2'], description: 'Switch to Headers tab' },
      { keys: ['⌥', '3'], description: 'Switch to Body tab' },
      { keys: ['⌥', '4'], description: 'Switch to Auth tab' },
      { keys: ['⌥', '5'], description: 'Switch to Scripts tab' },
      { keys: ['⌥', '6'], description: 'Switch to Settings tab' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['⌘', '1'], description: 'HTTP mode' },
      { keys: ['⌘', '2'], description: 'gRPC mode' },
      { keys: ['⌘', '3'], description: 'WebSocket mode' },
      { keys: ['⌘', 'I'], description: 'Import collection' },
      { keys: ['⌘', 'E'], description: 'Export collection' },
    ],
  },
  {
    title: 'Response',
    shortcuts: [
      { keys: ['⌘', 'C'], description: 'Copy response body' },
      { keys: ['⌘', 'S'], description: 'Save response to file' },
    ],
  },
];

export function ShortcutsSection() {
  return (
    <>
      <SectionHeader
        icon={KeyboardIcon}
        title="Shortcuts"
        description="Keyboard bindings available across the app."
      />

      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} className="mt-5 first:mt-0">
          <SectionLabel>{group.title}</SectionLabel>
          <Floater
            radius="panel"
            elevation="inset"
            className="px-4 grid grid-cols-2 gap-x-6 divide-x divide-sp-line"
          >
            {[0, 1].map((col) => (
              <ul
                key={col}
                className="divide-y divide-sp-line"
                style={{ paddingLeft: col === 1 ? '1.5rem' : 0 }}
              >
                {group.shortcuts
                  .filter((_, i) => i % 2 === col)
                  .map((s) => (
                    <li
                      key={s.description}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="text-sp-12-5 text-sp-text">{s.description}</span>
                      <span className="inline-flex items-center gap-1 shrink-0">
                        {s.keys.map((k, i) => (
                          <Kbd key={i} size="xs">
                            {k}
                          </Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
              </ul>
            ))}
          </Floater>
        </section>
      ))}
    </>
  );
}

export default ShortcutsSection;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/sections/__tests__/ProxySection.test.tsx src/features/settings/sections/__tests__/ShortcutsSection.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/sections/ProxySection.tsx \
  src/features/settings/sections/ShortcutsSection.tsx \
  src/features/settings/sections/__tests__/ProxySection.test.tsx \
  src/features/settings/sections/__tests__/ShortcutsSection.test.tsx
git commit -m "feat(settings): extract Proxy and Shortcuts sections"
```

---

### Task 4: Requests section (Judge removed) + Updates section

**Files:**

- Create: `src/features/settings/sections/RequestsSection.tsx`
- Create: `src/features/settings/sections/UpdatesSection.tsx`
- Test: `src/features/settings/sections/__tests__/RequestsSection.test.tsx`
- Test: `src/features/settings/sections/__tests__/UpdatesSection.test.tsx`

**Interfaces:**

- Consumes: `FieldGroup`, `FieldRow`, `SectionHeader`, `SectionLabel` from `../components/FieldPrimitives` (Task 1). `DesktopOnlyBadge` from `@/components/shared/DesktopOnlyBadge` (unchanged, not moved).
- Produces: default-exported `RequestsSection` (no longer renders Judge settings — that moves to `AiSection` in Task 8), `UpdatesSection`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/features/settings/sections/__tests__/RequestsSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestsSection } from '../RequestsSection';

describe('RequestsSection', () => {
  it('renders the Requests heading and timeout control, without Judge settings', () => {
    render(<RequestsSection />);
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('Default timeout')).toBeInTheDocument();
    // Judge settings moved to the AI section — must not render here anymore.
    expect(screen.queryByText('Enable LLM judge')).not.toBeInTheDocument();
  });
});
```

```tsx
// src/features/settings/sections/__tests__/UpdatesSection.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UpdatesSection } from '../UpdatesSection';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false), getElectronAPI: vi.fn(() => null) };
});

describe('UpdatesSection', () => {
  it('shows the web fallback copy when not running in Electron', () => {
    render(<UpdatesSection />);
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByText('Desktop only')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/settings/sections/__tests__/RequestsSection.test.tsx src/features/settings/sections/__tests__/UpdatesSection.test.tsx`
Expected: FAIL — modules don't exist yet

- [ ] **Step 3: Implement `RequestsSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:553-761`, minus the `JudgeSettingsSection` render which never appeared here — Judge was only rendered from the `ai` branch in the original switch, so no removal is needed inside this function itself, only the `JudgeSettingsSection` _definition_ moves to `AiSection.tsx` in Task 8)

```tsx
// src/features/settings/sections/RequestsSection.tsx
import { Send } from 'lucide-react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Floater, Segmented, Stepper, TextField, ToggleField } from '@/components/ui/spatial';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { MinTlsVersion } from '@/types';
import { FieldGroup, FieldRow, SectionHeader, SectionLabel } from '../components/FieldPrimitives';

export function RequestsSection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <>
      <SectionHeader
        icon={Send}
        title="Requests"
        description="Defaults for new requests and execution behavior."
      />

      <FieldGroup label="Timeouts">
        <FieldRow
          label="Default timeout"
          hint="Abort requests that don't respond within this window."
          control={
            <Stepper
              value={Math.round((settings.defaultTimeout ?? 30000) / 1000)}
              onChange={(v) => updateSettings({ defaultTimeout: Math.max(1, v) * 1000 })}
              min={1}
              max={600}
              step={5}
              unit="s"
              ariaLabel="Default timeout in seconds"
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="Redirects & TLS">
        <FieldRow
          label="Follow redirects"
          hint="Automatically follow HTTP 3xx responses."
          control={
            <ToggleField
              checked={settings.followRedirects ?? true}
              onChange={(v) => updateSettings({ followRedirects: v })}
              ariaLabel="Follow redirects"
            />
          }
        />
        {(settings.followRedirects ?? true) && (
          <>
            <FieldRow
              label="Max redirects"
              hint="Hard cap on redirect chain length."
              control={
                <Stepper
                  value={settings.maxRedirects ?? 10}
                  onChange={(v) => updateSettings({ maxRedirects: v })}
                  min={0}
                  max={50}
                  ariaLabel="Max redirects"
                />
              }
            />
            <FieldRow
              label="Follow original HTTP method"
              hint="RFC-compliant: don't downgrade 301 / 302 to GET."
              control={
                <ToggleField
                  checked={settings.followOriginalMethod === true}
                  onChange={(v) => updateSettings({ followOriginalMethod: v })}
                  ariaLabel="Follow original method on redirect"
                />
              }
            />
            <FieldRow
              label="Follow Authorization header"
              hint="Keep Authorization on cross-origin redirects. Default off."
              control={
                <ToggleField
                  checked={settings.followAuthHeader === true}
                  onChange={(v) => updateSettings({ followAuthHeader: v })}
                  ariaLabel="Follow Authorization across hostnames"
                />
              }
            />
            <FieldRow
              label="Remove Referer on redirect"
              hint="Strip the Referer header on every hop."
              control={
                <ToggleField
                  checked={settings.stripReferer === true}
                  onChange={(v) => updateSettings({ stripReferer: v })}
                  ariaLabel="Strip Referer on redirect"
                />
              }
            />
          </>
        )}
        <FieldRow
          label="Verify SSL certificates"
          hint="Disable only for trusted development hosts."
          control={
            <ToggleField
              checked={settings.verifySsl ?? true}
              onChange={(v) => updateSettings({ verifySsl: v })}
              ariaLabel="Verify SSL"
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="URL &amp; cookies">
        <FieldRow
          label="Encode URL automatically"
          hint="Percent-encode path & query. Disable when the upstream rejects encoded special chars."
          control={
            <ToggleField
              checked={settings.encodeUrlAutomatically !== false}
              onChange={(v) => updateSettings({ encodeUrlAutomatically: v })}
              ariaLabel="Encode URL automatically"
            />
          }
        />
        <FieldRow
          label="Disable cookie jar"
          hint="Skip the shared cookie store — no Cookie header is sent and Set-Cookie responses are not stored."
          control={
            <ToggleField
              checked={settings.disableCookieJar === true}
              onChange={(v) => updateSettings({ disableCookieJar: v })}
              ariaLabel="Disable cookie jar"
            />
          }
        />
      </FieldGroup>

      <section className="mt-5">
        <SectionLabel>
          <span className="inline-flex items-center">
            TLS (advanced)
            <DesktopOnlyBadge title="TLS handshake parameters can't be controlled from a browser/Worker. Desktop only." />
          </span>
        </SectionLabel>
        <Floater radius="panel" elevation="inset" className="px-4 divide-y divide-sp-line">
          <FieldRow
            label="Use server cipher suite order"
            hint="Honour the server's cipher preference order during handshake."
            control={
              <ToggleField
                checked={settings.serverCipherOrder === true}
                onChange={(v) => updateSettings({ serverCipherOrder: v })}
                ariaLabel="Use server cipher order"
              />
            }
          />
          <FieldRow
            label="Minimum TLS version"
            hint="Reject handshakes below this protocol version."
            control={
              <Segmented<'default' | MinTlsVersion>
                value={settings.minTlsVersion ?? 'default'}
                onChange={(v) =>
                  updateSettings(
                    v === 'default'
                      ? ({ minTlsVersion: undefined } as Partial<typeof settings>)
                      : { minTlsVersion: v }
                  )
                }
                size="sm"
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'TLSv1', label: '1.0' },
                  { value: 'TLSv1.1', label: '1.1' },
                  { value: 'TLSv1.2', label: '1.2' },
                  { value: 'TLSv1.3', label: '1.3' },
                ]}
                ariaLabel="Minimum TLS version"
              />
            }
          />
          <FieldRow
            label="Cipher suites"
            hint="OpenSSL-format colon-separated list. Leave blank for default."
            control={
              <TextField
                mono
                placeholder="ECDHE-RSA-AES128-GCM-SHA256"
                value={settings.cipherSuites ?? ''}
                onChange={(e) => updateSettings({ cipherSuites: e.target.value })}
                className="w-[260px]"
              />
            }
          />
        </Floater>
      </section>

      <FieldGroup label="History">
        <FieldRow
          label="Max history items"
          hint="Older entries are evicted once this cap is reached."
          control={
            <Stepper
              value={settings.maxHistoryItems ?? 100}
              onChange={(v) => updateSettings({ maxHistoryItems: v })}
              min={10}
              max={5000}
              step={10}
              ariaLabel="Max history items"
            />
          }
        />
      </FieldGroup>
    </>
  );
}

export default RequestsSection;
```

- [ ] **Step 4: Implement `UpdatesSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:1776-1890`)

```tsx
// src/features/settings/sections/UpdatesSection.tsx
import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Segmented, ToggleField } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_AUTO_UPDATE_SETTINGS } from '@/types';
import { FieldGroup, FieldRow, SectionHeader } from '../components/FieldPrimitives';

export function UpdatesSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const autoUpdate = settings.autoUpdate ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const handleCheck = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.updater.check();
      if (res.error) setCheckResult(`Check failed: ${res.error}`);
      else if (res.updateAvailable)
        setCheckResult(`Update available${res.version ? ` — v${res.version}` : ''}`);
      else setCheckResult(res.message ?? "You're up to date");
    } finally {
      setChecking(false);
    }
  }, []);

  if (!isElectron()) {
    return (
      <>
        <SectionHeader
          icon={Download}
          title="Updates"
          description="Automatic updates for the Restura desktop app."
        />
        <FieldGroup label="Updates">
          <FieldRow
            label="Current version"
            hint="The web app always serves the latest version — no manual update needed."
            control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
          />
          <FieldRow
            label="Desktop auto-update"
            hint="Background updates are available in the Restura desktop app."
            control={<DesktopOnlyBadge title="Auto-update is an Electron desktop feature." />}
          />
        </FieldGroup>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        icon={Download}
        title="Updates"
        description="Keep Restura up to date automatically, or check on demand."
      />

      <FieldGroup label="Automatic updates">
        <FieldRow
          label="Download updates automatically"
          hint="When on, new versions download in the background and prompt you to restart."
          control={
            <ToggleField
              checked={autoUpdate.autoDownload}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, autoDownload: v } })}
              ariaLabel="Download updates automatically"
            />
          }
        />
        <FieldRow
          label="Release channel"
          hint="Stable is recommended. Beta receives pre-releases earlier."
          control={
            <Segmented<'stable' | 'beta'>
              value={autoUpdate.channel}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, channel: v } })}
              options={[
                { value: 'stable', label: 'Stable' },
                { value: 'beta', label: 'Beta' },
              ]}
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="Check">
        <FieldRow
          label="Current version"
          control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
        />
        <FieldRow
          label="Check for updates"
          hint={checkResult ?? 'Fetch the latest release from GitHub.'}
          control={
            <button
              type="button"
              onClick={() => void handleCheck()}
              disabled={checking}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
                'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
                'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} aria-hidden />
              <span>{checking ? 'Checking…' : 'Check now'}</span>
            </button>
          }
        />
      </FieldGroup>
    </>
  );
}

export default UpdatesSection;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/sections/__tests__/RequestsSection.test.tsx src/features/settings/sections/__tests__/UpdatesSection.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/sections/RequestsSection.tsx \
  src/features/settings/sections/UpdatesSection.tsx \
  src/features/settings/sections/__tests__/RequestsSection.test.tsx \
  src/features/settings/sections/__tests__/UpdatesSection.test.tsx
git commit -m "feat(settings): extract Requests and Updates sections"
```

---

### Task 5: Data section

**Files:**

- Create: `src/features/settings/sections/DataSection.tsx`
- Test: `src/features/settings/sections/__tests__/DataSection.test.tsx`

**Interfaces:**

- Consumes: `DataButton` from `../components/DataButton` (Task 1), `FieldPrimitives` helpers (Task 1).
- Produces: default-exported `DataSection` — now also renders `<CaptureBridgeCard />` inline (folded in from the monolith's page-level `{activeSection === 'data' && (<><DataSection/><CaptureBridgeCard/></>)}` so `SettingsPage`'s section lookup map can stay uniform, one component per section).

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/sections/__tests__/DataSection.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataSection } from '../DataSection';

vi.mock('@/hooks/useStorageMonitor', () => ({
  useStorageMonitor: () => ({
    status: { totalRecords: 0, percentage: 0, level: 'ok', message: null },
    checkStorage: vi.fn(),
    formattedUsed: '0 B',
    formattedAvailable: '10 GB',
  }),
}));

describe('DataSection', () => {
  it('renders the Data heading, backup actions, and the capture bridge card', () => {
    render(<DataSection />);
    expect(screen.getByRole('heading', { name: 'Data' })).toBeInTheDocument();
    expect(screen.getByText('Export data')).toBeInTheDocument();
    expect(screen.getByText('Clear all data')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/sections/__tests__/DataSection.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `DataSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:1501-1667`, `CaptureBridgeCard` appended)

```tsx
// src/features/settings/sections/DataSection.tsx
import { Database, Download, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { CaptureBridgeCard } from '@/components/shared/CaptureBridgeCard';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Floater } from '@/components/ui/spatial';
import { useStorageMonitor } from '@/hooks/useStorageMonitor';
import {
  clearDexieStorage,
  exportDexieData,
  importDexieData,
  secureDeleteAllDexieData,
} from '@/lib/shared/dexie-storage';
import { downloadBlob, readFileAsText } from '@/lib/shared/file-utils';
import { DataButton } from '../components/DataButton';
import { SectionHeader, SectionLabel } from '../components/FieldPrimitives';

export function DataSection() {
  // autoPrune:false — this is a display-only usage indicator; don't silently
  // prune history just because the user opened the Data tab.
  const { status, checkStorage, formattedUsed, formattedAvailable } = useStorageMonitor({
    autoPrune: false,
  });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'clear' | 'secure'>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (action: () => Promise<void>, success: string, failPrefix: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        await checkStorage();
        toast.success(success);
        return true;
      } catch (e) {
        toast.error(`${failPrefix}: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkStorage]
  );

  // Import / clear / secure-delete rewrite Dexie out from under the in-memory
  // Zustand stores, which would otherwise re-persist their stale state over the
  // new rows. Reload once the success toast has had a moment to show so the
  // freshly persisted data is what boots.
  const reloadAfter = (ok: boolean) => {
    if (ok) setTimeout(() => window.location.reload(), 900);
  };

  const handleExport = () =>
    run(
      async () =>
        downloadBlob(
          await exportDexieData(),
          `restura-backup-${new Date().toISOString().split('T')[0]}.json`
        ),
      'Data exported',
      'Export failed'
    );

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(
      async () => importDexieData(await file.text()),
      'Data imported — reloading…',
      'Import failed'
    ).then(reloadAfter);
  };

  const confirmDestructive = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'clear') {
      void run(clearDexieStorage, 'All data cleared — reloading…', 'Clear failed').then(
        reloadAfter
      );
    } else if (which === 'secure') {
      void run(
        secureDeleteAllDexieData,
        'All data securely deleted — reloading…',
        'Secure delete failed'
      ).then(reloadAfter);
    }
  };

  const levelColor =
    status.level === 'critical'
      ? '#f43f5e'
      : status.level === 'warning'
        ? '#f59e0b'
        : 'var(--sp-accent)';

  return (
    <>
      <SectionHeader
        icon={Database}
        title="Data"
        description="Back up, restore, or wipe your locally stored data. Everything stays on this device."
      />

      <section className="mt-5 first:mt-0">
        <SectionLabel>Storage usage</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 space-y-2">
          <div className="flex items-center justify-between text-sp-12 font-mono text-sp-muted">
            <span>
              {status.totalRecords} records · {formattedUsed}
            </span>
            <span>
              {status.percentage.toFixed(1)}% of {formattedAvailable}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-sp-line overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${status.totalRecords > 0 ? Math.max(2, Math.min(100, status.percentage)) : 0}%`,
                background: levelColor,
              }}
            />
          </div>
          {status.message && (
            <p className="text-sp-11 text-amber-500 dark:text-amber-400">{status.message}</p>
          )}
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Backup</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => void handleExport()} disabled={busy} icon={Download}>
            Export data
          </DataButton>
          <DataButton onClick={() => fileInputRef.current?.click()} disabled={busy} icon={Upload}>
            Import data
          </DataButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
            aria-label="Import data file"
          />
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Danger zone</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => setConfirm('clear')} disabled={busy} icon={Trash2} danger>
            Clear all data
          </DataButton>
          <DataButton onClick={() => setConfirm('secure')} disabled={busy} icon={Trash2} danger>
            Secure delete
          </DataButton>
        </Floater>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        variant="destructive"
        title={confirm === 'secure' ? 'Securely delete all data?' : 'Clear all data?'}
        description={
          confirm === 'secure'
            ? 'Overwrites every stored record with random data before deleting it, then wipes the database — for use on a shared machine. This cannot be undone.'
            : 'Permanently deletes all collections, history, environments, and settings from this device. This cannot be undone.'
        }
        confirmText={confirm === 'secure' ? 'Secure delete' : 'Clear all'}
        onConfirm={confirmDestructive}
      />

      <CaptureBridgeCard />
    </>
  );
}

export default DataSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/sections/__tests__/DataSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/sections/DataSection.tsx \
  src/features/settings/sections/__tests__/DataSection.test.tsx
git commit -m "feat(settings): extract Data section, fold in CaptureBridgeCard"
```

---

### Task 6: Certificates section

**Files:**

- Create: `src/features/settings/sections/CertificatesSection.tsx`
- Test: `src/features/settings/sections/__tests__/CertificatesSection.test.tsx`

**Interfaces:**

- Consumes: `FieldPrimitives` helpers (Task 1).
- Produces: default-exported `CertificatesSection`, containing (as internal, non-exported helpers, exactly as in the monolith) `HostScopeFields`, `PerDomainCertificates`, and `stripPort`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/sections/__tests__/CertificatesSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CertificatesSection } from '../CertificatesSection';

describe('CertificatesSection', () => {
  it('renders the client cert UI and the CA paste textarea', () => {
    render(<CertificatesSection />);
    expect(screen.getByRole('heading', { name: 'Certificates' })).toBeInTheDocument();
    expect(screen.getByText(/PFX \/ P12/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/paste a PEM bundle/i)).toBeInTheDocument();
  });

  it('renders per-domain certificate add buttons', () => {
    render(<CertificatesSection />);
    expect(screen.getByText('Add client certificate')).toBeInTheDocument();
    expect(screen.getByText('Add CA certificate')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/sections/__tests__/CertificatesSection.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `CertificatesSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:994-1337`)

```tsx
// src/features/settings/sections/CertificatesSection.tsx
import { Info, ShieldCheck, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Floater } from '@/components/ui/spatial';
import { CertificateOverride } from '@/features/http/components/CertificateOverride';
import { readFileAsText } from '@/lib/shared/file-utils';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ClientCert } from '@/types';
import { SectionHeader, SectionLabel } from '../components/FieldPrimitives';

export function CertificatesSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setClientCert = useSettingsStore((s) => s.setClientCert);
  const setCaCert = useSettingsStore((s) => s.setCaCert);
  const [caFileName, setCaFileName] = React.useState('');
  const [pastedCa, setPastedCa] = React.useState(settings.caCert?.pem ?? '');
  const caFileInputRef = React.useRef<HTMLInputElement>(null);

  const handleCaFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      setCaFileName(file.name);
      setPastedCa('');
      setCaCert({ pem: text });
      toast.success(`CA loaded from ${file.name}`);
    } catch {
      toast.error('Failed to read certificate file');
    }
    e.target.value = '';
  };

  const handleCaPaste = (value: string) => {
    setPastedCa(value);
    setCaFileName('');
    if (value.trim()) {
      setCaCert({ pem: value.trim() });
    } else {
      setCaCert(undefined);
    }
  };

  const handleClearCa = () => {
    setCaCert(undefined);
    setCaFileName('');
    setPastedCa('');
    if (caFileInputRef.current) caFileInputRef.current.value = '';
  };

  const hasCa = !!settings.caCert?.pem;

  return (
    <>
      <SectionHeader
        icon={ShieldCheck}
        title="Certificates"
        description={
          <>
            Configure client certificates and custom CA bundles.
            <DesktopOnlyBadge title="Browsers can't present client certificates or override the system trust store. Certificates only take effect in the Restura desktop app." />
          </>
        }
      />

      <SectionLabel>Client certificate (mTLS)</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4">
        <CertificateOverride clientCert={settings.clientCert} onCertChange={setClientCert} />
      </Floater>

      <SectionLabel>Custom CA certificate</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            ref={caFileInputRef}
            type="file"
            accept=".pem,.crt,.cer"
            onChange={handleCaFileSelect}
            className="hidden"
            aria-label="Choose CA certificate file"
          />
          <button
            type="button"
            onClick={() => caFileInputRef.current?.click()}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
              'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
              'hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <Upload size={12} aria-hidden="true" />
            Choose file
          </button>
          <span className="text-sp-11-5 text-sp-muted font-mono truncate">
            {caFileName || (hasCa ? '(loaded)' : 'No file chosen')}
          </span>
          {hasCa && (
            <button
              type="button"
              onClick={handleClearCa}
              aria-label="Clear CA certificate"
              className={cn(
                'ml-auto inline-flex items-center justify-center w-7 h-7 rounded-sp-btn',
                'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
              )}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        <div>
          <label htmlFor="ca-pem-paste" className="text-sp-11-5 text-sp-muted block mb-1">
            …or paste a PEM bundle
          </label>
          <textarea
            id="ca-pem-paste"
            aria-label="Paste a PEM bundle"
            value={pastedCa}
            onChange={(e) => handleCaPaste(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----&#10;..."
            spellCheck={false}
            className={cn(
              'w-full min-h-[120px] rounded-sp-btn bg-sp-surface border border-sp-line',
              'p-2 font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
              'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]',
              'transition-colors resize-y'
            )}
          />
        </div>
        <p className="text-sp-11 text-amber-500 dark:text-amber-400 flex items-start gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            A custom CA replaces the system trust store for Restura's outbound requests. Only add a
            CA you trust.
          </span>
        </p>
      </Floater>

      <PerDomainCertificates />
    </>
  );
}

/** Host[:port] input shared by both per-domain editors. */
function HostScopeFields({
  host,
  port,
  onHostChange,
  onPortChange,
}: {
  host: string;
  port: number | undefined;
  onHostChange: (v: string) => void;
  onPortChange: (v: number | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={host}
        onChange={(e) => onHostChange(e.target.value)}
        aria-label="Host or host pattern"
        placeholder="api.example.com or *.example.com"
        spellCheck={false}
        className={cn(
          'flex-1 h-8 px-2 rounded-sp-btn bg-sp-surface border border-sp-line',
          'font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
          'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]'
        )}
      />
      <input
        value={port ?? ''}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (v === '') {
            onPortChange(undefined);
            return;
          }
          // Guard against NaN / out-of-range: a non-numeric paste would
          // otherwise persist `port: NaN` into the host entry.
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 65535) onPortChange(n);
        }}
        inputMode="numeric"
        aria-label="Port"
        placeholder="port"
        spellCheck={false}
        className={cn(
          'w-20 h-8 px-2 rounded-sp-btn bg-sp-surface border border-sp-line',
          'font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
          'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]'
        )}
      />
    </div>
  );
}

function PerDomainCertificates() {
  const settings = useSettingsStore((s) => s.settings);
  const upsertHostClientCert = useSettingsStore((s) => s.upsertHostClientCert);
  const removeHostClientCert = useSettingsStore((s) => s.removeHostClientCert);
  const upsertHostCaCert = useSettingsStore((s) => s.upsertHostCaCert);
  const removeHostCaCert = useSettingsStore((s) => s.removeHostCaCert);

  const clientCerts = settings.clientCertificates ?? [];
  const caCerts = settings.caCertificates ?? [];

  const newId = () => {
    // crypto.randomUUID is available in the renderer (secure context) and in
    // Electron; fall back to a timestamp-free random for non-secure dev.
    try {
      return crypto.randomUUID();
    } catch {
      return `cert-${Math.random().toString(36).slice(2)}`;
    }
  };

  const addClientCert = () =>
    upsertHostClientCert({ id: newId(), host: '', cert: { format: 'pfx' } });
  const addCaCert = () => upsertHostCaCert({ id: newId(), host: '', pem: '' });

  return (
    <>
      <SectionLabel>Per-domain client certificates</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <p className="text-sp-11 text-sp-muted">
          Present a different mTLS certificate per host. The most specific matching entry wins;
          exact host beats <span className="font-mono">*.wildcard</span>. A match takes precedence
          over the global client certificate above.
        </p>
        {clientCerts.map((entry) => (
          <div key={entry.id} className="rounded-sp-btn border border-sp-line p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <HostScopeFields
                  host={entry.host}
                  port={entry.port}
                  onHostChange={(host) => upsertHostClientCert({ ...entry, host })}
                  onPortChange={(port) =>
                    upsertHostClientCert(port === undefined ? stripPort(entry) : { ...entry, port })
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => removeHostClientCert(entry.id)}
                aria-label="Remove certificate"
                className={cn(
                  'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                  'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <CertificateOverride
              clientCert={entry.cert}
              onCertChange={(cert: ClientCert | undefined) =>
                upsertHostClientCert({ ...entry, cert: cert ?? { format: 'pfx' } })
              }
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addClientCert}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
            'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
            'hover:bg-sp-hover transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Add client certificate
        </button>
      </Floater>

      <SectionLabel>Per-domain CA certificates</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <p className="text-sp-11 text-sp-muted">
          Trust a custom CA only for specific hosts (instead of replacing the whole trust store).
        </p>
        {caCerts.map((entry) => (
          <div key={entry.id} className="rounded-sp-btn border border-sp-line p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <HostScopeFields
                  host={entry.host}
                  port={entry.port}
                  onHostChange={(host) => upsertHostCaCert({ ...entry, host })}
                  onPortChange={(port) =>
                    upsertHostCaCert(port === undefined ? stripPort(entry) : { ...entry, port })
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => removeHostCaCert(entry.id)}
                aria-label="Remove CA certificate"
                className={cn(
                  'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                  'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <textarea
              value={entry.pem}
              onChange={(e) => upsertHostCaCert({ ...entry, pem: e.target.value })}
              aria-label="CA certificate PEM"
              placeholder="-----BEGIN CERTIFICATE-----&#10;..."
              spellCheck={false}
              className={cn(
                'w-full min-h-[90px] rounded-sp-btn bg-sp-surface border border-sp-line',
                'p-2 font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
                'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]',
                'transition-colors resize-y'
              )}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addCaCert}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
            'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
            'hover:bg-sp-hover transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Add CA certificate
        </button>
      </Floater>
    </>
  );
}

/** Return a copy of a host-scoped entry with `port` omitted (EOPT-friendly). */
function stripPort<T extends { port?: number }>(entry: T): T {
  const { port: _omit, ...rest } = entry;
  void _omit;
  return rest as T;
}

export default CertificatesSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/sections/__tests__/CertificatesSection.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/sections/CertificatesSection.tsx \
  src/features/settings/sections/__tests__/CertificatesSection.test.tsx
git commit -m "feat(settings): extract Certificates section"
```

---

### Task 7: Secrets section

**Files:**

- Create: `src/features/settings/sections/SecretsSection.tsx`
- Test: `src/features/settings/sections/__tests__/SecretsSection.test.tsx`

**Interfaces:**

- Consumes: `FieldPrimitives` helpers (Task 1).
- Produces: default-exported `SecretsSection`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/sections/__tests__/SecretsSection.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecretsSection } from '../SecretsSection';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false), getElectronAPI: vi.fn(() => null) };
});

describe('SecretsSection', () => {
  it('shows the DesktopOnlyBadge on web instead of the stub copy', () => {
    render(<SecretsSection />);
    expect(screen.getByText('Desktop only')).toBeInTheDocument();
    expect(screen.queryByText(/vault overview is coming/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/sections/__tests__/SecretsSection.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `SecretsSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:1343-1460`)

```tsx
// src/features/settings/sections/SecretsSection.tsx
import { KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { SectionHeader, SectionLabel } from '../components/FieldPrimitives';

interface SecretHandleSummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}

export function SecretsSection() {
  const electron = isElectron();
  const [handles, setHandles] = useState<SecretHandleSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!electron) return;
    const api = getElectronAPI();
    if (!api?.secrets?.list) return;
    setLoading(true);
    try {
      const result = await api.secrets.list();
      if (result.ok) {
        setHandles(result.handles);
      } else {
        toast.error(`Failed to load handles: ${result.error}`);
      }
    } finally {
      setLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (id: string) => {
    const api = getElectronAPI();
    if (!api?.secrets?.delete) return;
    const result = await api.secrets.delete(id);
    if (!result.ok) {
      toast.error(`Failed to delete: ${result.error}`);
      return;
    }
    toast.success('Secret deleted');
    void refresh();
  };

  if (!electron) {
    return (
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description={
          <>
            Tokens and keys referenced from your collections.
            <DesktopOnlyBadge title="Secret storage requires the Restura desktop app — the browser has no OS keychain." />
          </>
        }
      />
    );
  }

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description="Plaintext for these handles lives in the OS keychain. Restura never reads them in the renderer; the main process resolves them at the wire boundary only when a request is sent."
      />

      <SectionLabel>Stored handles</SectionLabel>
      {loading ? (
        <Floater radius="panel" elevation="inset" className="p-4">
          <p className="text-sp-12 text-sp-muted font-mono">Loading…</p>
        </Floater>
      ) : handles.length === 0 ? (
        <Floater radius="panel" elevation="inset" className="p-5">
          <p className="text-sp-13 text-sp-muted">
            No stored secrets yet. Use the &ldquo;Store&rdquo; button next to a password field in
            any auth configuration to create a handle.
          </p>
        </Floater>
      ) : (
        <Floater radius="panel" elevation="inset" className="overflow-hidden">
          <ul className="divide-y divide-sp-line">
            {handles.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <KeyRound className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sp-12 font-mono text-sp-text truncate">
                      {h.label || h.id.slice(0, 8) + '…'}
                    </p>
                    <p className="text-sp-11 text-sp-muted font-mono">
                      {new Date(h.createdAt).toLocaleString()}
                      {h.scope ? ` · scope: ${h.scope}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(h.id)}
                  aria-label={`Delete handle ${h.label || h.id}`}
                  title="Delete this handle"
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                    'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                  )}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        </Floater>
      )}
    </>
  );
}

export default SecretsSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/sections/__tests__/SecretsSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/sections/SecretsSection.tsx \
  src/features/settings/sections/__tests__/SecretsSection.test.tsx
git commit -m "feat(settings): extract Secrets section"
```

---

### Task 8: AI section (absorbs Judge/scorer settings)

**Files:**

- Create: `src/features/settings/sections/AiSection.tsx`
- Test: `src/features/settings/sections/__tests__/AiSection.test.tsx`

**Interfaces:**

- Consumes: `DataButton`, `FieldPrimitives` helpers (Task 1). `ProviderSettings` lazy-loaded from `@/features/ai/components/ProviderSettings` (unchanged).
- Produces: default-exported `AiSection`, containing the moved `JudgeSettingsSection` (previously in `RequestsSection`) as an internal, non-exported helper, plus a redesigned web fallback that reuses the existing `DesktopOnlyBadge` idiom (matching how Certificates/Secrets/Updates already communicate desktop-only, per spec §9) instead of the old bare-text fallback.

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/sections/__tests__/AiSection.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/features/ai/components/ProviderSettings', () => ({
  ProviderSettings: () => <div>Provider settings stub</div>,
}));

describe('AiSection', () => {
  it('shows a designed desktop-only fallback on web, not the bare old message', async () => {
    vi.doMock('@/lib/shared/platform', async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, isElectron: vi.fn(() => false) };
    });
    const { AiSection } = await import('../AiSection');
    render(<AiSection />);
    expect(screen.getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    expect(screen.getByText('Desktop only')).toBeInTheDocument();
    expect(
      screen.queryByText('AI features are available in the desktop app only.')
    ).not.toBeInTheDocument();
  });

  it('renders Judge/scorer settings under AI on desktop, not under Requests', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/platform', async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, isElectron: vi.fn(() => true), getElectronAPI: vi.fn(() => null) };
    });
    const { AiSection } = await import('../AiSection');
    render(<AiSection />);
    expect(screen.getByText('Enable LLM judge')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/sections/__tests__/AiSection.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `AiSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:57-61,275-285,841-988`, plus the web-fallback redesign called out in spec §9)

```tsx
// src/features/settings/sections/AiSection.tsx
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { KeyRound, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Segmented, TextField, ToggleField } from '@/components/ui/spatial';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_JUDGE_SETTINGS } from '@/types';
import { DataButton } from '../components/DataButton';
import { FieldGroup, FieldRow, SectionHeader } from '../components/FieldPrimitives';

const ProviderSettings = lazyComponent(async () => {
  const m = await import('@/features/ai/components/ProviderSettings');
  const Comp: React.ComponentType<object> = m.ProviderSettings;
  return { default: Comp };
});

const JUDGE_PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'Compatible' },
];

function JudgeSettingsSection() {
  const judge = useSettingsStore((s) => s.settings.judge) ?? DEFAULT_JUDGE_SETTINGS;
  const updateJudge = useSettingsStore((s) => s.updateJudge);
  const isLocal = isLocalProvider(judge.provider);
  const [pendingKey, setPendingKey] = useState('');

  // The plaintext key never lands in the store — it's stored in the OS keychain
  // (same path as the AI assistant) and only its handle id is persisted.
  const saveJudgeKey = async () => {
    const value = pendingKey.trim();
    if (!value) return;
    const api = getElectronAPI()?.secrets;
    if (!api) return;
    const result = await api.store({ scope: 'ai:judge', value, label: 'judge key' });
    if (!result.ok) {
      toast.error(`Failed to store key: ${result.error}`);
      return;
    }
    updateJudge({ apiKeyHandleId: result.id });
    setPendingKey('');
    toast.success('Judge API key stored');
  };

  const clearJudgeKey = async () => {
    const api = getElectronAPI()?.secrets;
    if (judge.apiKeyHandleId && api) {
      await api.delete(judge.apiKeyHandleId);
    }
    updateJudge({ apiKeyHandleId: undefined });
  };

  return (
    <FieldGroup label="Semantic assertions (rs.judge)">
      <FieldRow
        label="Enable LLM judge"
        hint="Lets test scripts call rs.judge(output, { rubric }) to assert on response meaning."
        control={
          <ToggleField
            checked={judge.enabled}
            onChange={(v) => updateJudge({ enabled: v })}
            ariaLabel="Enable LLM judge"
          />
        }
      />
      <FieldRow
        label="Judge provider"
        control={
          <Segmented<Provider>
            value={judge.provider}
            onChange={(v) => updateJudge({ provider: v })}
            options={JUDGE_PROVIDERS}
          />
        }
      />
      <FieldRow
        label="Judge model"
        hint="e.g. gpt-4o-mini, claude-3-5-haiku, or a local Ollama model."
        control={
          <TextField
            mono
            placeholder="gpt-4o-mini"
            value={judge.model}
            onChange={(e) => updateJudge({ model: e.target.value })}
            disabled={!judge.enabled}
            className="w-[260px]"
          />
        }
      />
      {isLocal && (
        <FieldRow
          label="Base URL"
          hint="Required for local runtimes (e.g. http://localhost:11434)."
          control={
            <TextField
              mono
              placeholder="http://localhost:11434"
              value={judge.baseUrl ?? ''}
              onChange={(e) => updateJudge({ baseUrl: e.target.value })}
              disabled={!judge.enabled}
              className="w-[260px]"
            />
          }
        />
      )}
      <FieldRow
        label="API key"
        hint={
          isLocal
            ? 'Optional for local runtimes (only if your gateway requires auth).'
            : 'Required for cloud providers. Stored in the OS keychain; the renderer never sees it.'
        }
        control={
          judge.apiKeyHandleId ? (
            <div className="flex items-center gap-2">
              <span className="text-sp-12 font-mono text-sp-muted">
                handle {judge.apiKeyHandleId.slice(0, 8)}…
              </span>
              <DataButton icon={Trash2} danger onClick={() => void clearJudgeKey()}>
                Clear
              </DataButton>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <TextField
                type="password"
                mono
                placeholder="sk-…"
                value={pendingKey}
                onChange={(e) => setPendingKey(e.target.value)}
                disabled={!judge.enabled}
                className="w-[200px]"
              />
              <DataButton
                icon={KeyRound}
                disabled={!judge.enabled || !pendingKey.trim()}
                onClick={() => void saveJudgeKey()}
              >
                Save
              </DataButton>
            </div>
          )
        }
      />
      <FieldRow
        label="Redact before judging"
        hint="Strip secret-looking tokens from the response before it is sent to the judge. For sensitive APIs, prefer a local Ollama judge so responses never leave your machine."
        control={
          <ToggleField
            checked={judge.redactBeforeJudge}
            onChange={(v) => updateJudge({ redactBeforeJudge: v })}
            ariaLabel="Redact before judging"
          />
        }
      />
    </FieldGroup>
  );
}

export function AiSection() {
  if (!isElectron()) {
    return (
      <>
        <SectionHeader
          icon={Sparkles}
          title="AI"
          description={
            <>
              AI assistant, provider config, and semantic-assertion judging.
              <DesktopOnlyBadge title="AI calls run entirely from the Electron main process, straight to your provider — your API key never touches Restura's servers or even leaves the renderer. That privacy story only holds on desktop." />
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <SectionHeader
        icon={Sparkles}
        title="AI"
        description="Configure your AI provider, API key, and semantic-assertion judge."
      />
      <ProviderSettings />
      <JudgeSettingsSection />
    </>
  );
}

export default AiSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/sections/__tests__/AiSection.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/sections/AiSection.tsx \
  src/features/settings/sections/__tests__/AiSection.test.tsx
git commit -m "feat(settings): extract AI section, fold in Judge settings and redesign web fallback"
```

---

### Task 9: About section

**Files:**

- Create: `src/features/settings/sections/AboutSection.tsx`
- Test: `src/features/settings/sections/__tests__/AboutSection.test.tsx`

**Interfaces:**

- Consumes: `FieldGroup`, `SectionHeader`, `SectionLabel` from `../components/FieldPrimitives` (Task 1).
- Produces: default-exported `AboutSection`, containing internal `AuthorAvatar`, `GithubMark`, `LinkCard` helpers (unchanged from the monolith, not shared elsewhere).

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/sections/__tests__/AboutSection.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AboutSection } from '../AboutSection';

describe('AboutSection', () => {
  it('renders the hero card, author, and resource links', () => {
    render(<AboutSection />);
    expect(screen.getByText('Restura')).toBeInTheDocument();
    expect(screen.getByText('Dipjyoti Metia')).toBeInTheDocument();
    expect(screen.getByText('GitHub repository')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/sections/__tests__/AboutSection.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `AboutSection.tsx`** (moved verbatim from `SettingsDrawer.tsx:1726-2018`)

```tsx
// src/features/settings/sections/AboutSection.tsx
import { Info, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Floater } from '@/components/ui/spatial';
import { Logo } from '@/components/shared/Logo';
import { cn } from '@/lib/shared/utils';
import { FieldGroup, SectionHeader, SectionLabel } from '../components/FieldPrimitives';

interface AuthorAvatarProps {
  username: string;
  initials: string;
  alt: string;
}

/**
 * GitHub avatar with graceful fallback. The initials/gradient render as the
 * background, so even before the image loads (or if the fetch fails) the
 * row stays visually anchored. On error we hide the img and let the
 * background show through.
 */
function AuthorAvatar({ username, initials, alt }: AuthorAvatarProps) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="relative flex items-center justify-center size-10 rounded-full overflow-hidden shrink-0 text-sp-13 font-bold text-white"
      style={{
        background: 'linear-gradient(135deg, var(--sp-accent), #a78bfa)',
        boxShadow: '0 4px 12px var(--sp-accent-glow-55)',
      }}
    >
      <span aria-hidden={!failed}>{initials}</span>
      {!failed && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onError is a load-failure fallback, not a user interaction
        <img
          src={`https://github.com/${username}.png?size=80`}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}

function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56v-2.16c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.3-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.55C20.21 21.4 23.5 17.09 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

interface LinkCardProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  href: string;
}

function LinkCard({ icon, label, hint, href }: LinkCardProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'group flex items-center gap-3 p-3 rounded-sp-btn',
        'bg-sp-surface-lo border border-sp-line',
        'hover:border-sp-accent hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
      )}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center size-9 rounded-sp-btn shrink-0 text-sp-muted group-hover:text-sp-accent transition-colors"
        style={{ background: 'var(--sp-surface)' }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        <div className="text-sp-11-5 text-sp-muted font-mono truncate">{hint}</div>
      </div>
    </a>
  );
}

export function AboutSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <>
      <SectionHeader
        icon={Info}
        title="About"
        description="Build details, author, and project links."
      />

      {/* Hero card — large logo + brand + version pill + tagline. Anchors
          the About page so it doesn't read as a settings list. */}
      <Floater radius="panel" elevation="inset" className="p-6 mt-2 relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 0% 0%, var(--sp-accent-glow-33), transparent 55%)',
          }}
        />
        <div className="relative flex items-center gap-5">
          <Logo size={64} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-sp-22 font-bold text-sp-text leading-none">Restura</span>
              <span
                className="inline-flex items-center px-2 h-5 rounded-sp-pill text-sp-11 font-mono font-semibold text-sp-accent border border-sp-line"
                style={{ background: 'var(--sp-accent-glow-33)' }}
              >
                v{version}
              </span>
            </div>
            <p className="text-sp-13 text-sp-muted mt-1.5">
              A modern multi-protocol API client for HTTP, GraphQL, gRPC, WebSocket, and more.
            </p>
            <p className="text-sp-11 text-sp-dim mt-1 font-mono">Spatial Depth design system</p>
          </div>
        </div>
      </Floater>

      <FieldGroup label="Author">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-3">
          <AuthorAvatar username="dipjyotimetia" initials="DM" alt="Dipjyoti Metia" />
          <div className="min-w-0">
            <div className="text-sp-13 font-semibold text-sp-text">Dipjyoti Metia</div>
            <div className="text-sp-11-5 text-sp-muted">Creator &amp; maintainer</div>
          </div>
          <a
            href="https://github.com/dipjyotimetia"
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
              'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
              'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <GithubMark size={13} />
            <span>Follow</span>
          </a>
        </div>
      </FieldGroup>

      <section className="mt-5">
        <SectionLabel>Resources</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          <LinkCard
            icon={<GithubMark size={16} />}
            label="GitHub repository"
            hint="Source code & issues"
            href="https://github.com/dipjyotimetia/restura"
          />
          <LinkCard
            icon={<Info size={16} />}
            label="Documentation"
            hint="docs.restura.dev"
            href="https://docs.restura.dev"
          />
          <LinkCard
            icon={<ShieldCheck size={16} />}
            label="Privacy Policy"
            hint="restura.dev/privacy"
            href="https://restura.dev/privacy"
          />
        </div>
      </section>
    </>
  );
}

export default AboutSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/sections/__tests__/AboutSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/sections/AboutSection.tsx \
  src/features/settings/sections/__tests__/AboutSection.test.tsx
git commit -m "feat(settings): extract About section"
```

---

### Task 10: SettingsSidebar + SettingsSearch

**Files:**

- Create: `src/features/settings/components/SettingsSearch.tsx`
- Create: `src/features/settings/components/SettingsSidebar.tsx`
- Test: `src/features/settings/components/__tests__/SettingsSidebar.test.tsx`

**Interfaces:**

- Consumes: `SECTIONS`, `SectionId`, `filterSections` from `../lib/sectionRegistry` (Task 1).
- Produces:
  - `SettingsSearch({ value, onChange }: { value: string; onChange: (v: string) => void })`
  - `SettingsSidebar({ activeSectionId, onSelect, query, onQueryChange }: { activeSectionId: SectionId; onSelect: (id: SectionId) => void; query: string; onQueryChange: (v: string) => void })`

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/components/__tests__/SettingsSidebar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSidebar } from '../SettingsSidebar';

describe('SettingsSidebar', () => {
  it('renders all 11 section rows and calls onSelect when one is clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsSidebar
        activeSectionId="general"
        onSelect={onSelect}
        query=""
        onQueryChange={vi.fn()}
      />
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(nav.querySelectorAll('button[role="tab"]')).toHaveLength(11);

    await user.click(screen.getByRole('tab', { name: /proxy/i }));
    expect(onSelect).toHaveBeenCalledWith('proxy');
  });

  it('marks the active section with aria-selected', () => {
    render(
      <SettingsSidebar
        activeSectionId="certificates"
        onSelect={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
      />
    );
    expect(screen.getByRole('tab', { name: /certificates/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('filters the section list as the search query changes', () => {
    render(
      <SettingsSidebar
        activeSectionId="general"
        onSelect={vi.fn()}
        query="mtls"
        onQueryChange={vi.fn()}
      />
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(nav.querySelectorAll('button[role="tab"]')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /certificates/i })).toBeInTheDocument();
  });

  it('shows an empty state when the query matches nothing', () => {
    render(
      <SettingsSidebar
        activeSectionId="general"
        onSelect={vi.fn()}
        query="xyzzy-no-match"
        onQueryChange={vi.fn()}
      />
    );
    expect(screen.getByText(/no settings found for/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/components/__tests__/SettingsSidebar.test.tsx`
Expected: FAIL — modules don't exist yet

- [ ] **Step 3: Implement `SettingsSearch.tsx`**

```tsx
// src/features/settings/components/SettingsSearch.tsx
import { Search } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

export function SettingsSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative px-2 pb-2">
      <Search
        size={13}
        className="absolute left-4.5 top-1/2 -translate-y-1/2 text-sp-dim pointer-events-none"
        aria-hidden="true"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        className={cn(
          'w-full h-8 pl-7 pr-2.5 rounded-sp-btn bg-sp-inset border border-sp-line',
          'text-sp-12 text-sp-text placeholder:text-sp-dim',
          'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]',
          'transition-colors'
        )}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implement `SettingsSidebar.tsx`** (new component — nav rail restyled from `SettingsDrawer.tsx:224-265`, with search wired in per spec §5/§7)

```tsx
// src/features/settings/components/SettingsSidebar.tsx
import { cn } from '@/lib/shared/utils';
import { SECTIONS, filterSections, type SectionId } from '../lib/sectionRegistry';
import { SettingsSearch } from './SettingsSearch';

export function SettingsSidebar({
  activeSectionId,
  onSelect,
  query,
  onQueryChange,
}: {
  activeSectionId: SectionId;
  onSelect: (id: SectionId) => void;
  query: string;
  onQueryChange: (v: string) => void;
}) {
  const visible = filterSections(query, SECTIONS);

  return (
    <div className="w-60 shrink-0 border-r border-sp-line sp-floater flex flex-col">
      <div className="pt-3">
        <SettingsSearch value={query} onChange={onQueryChange} />
      </div>
      <nav
        aria-label="Settings sections"
        role="tablist"
        className="flex-1 px-2 pb-4 overflow-y-auto flex flex-col gap-0.5"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-sp-12 text-sp-muted">
            No settings found for &ldquo;{query}&rdquo;
          </p>
        ) : (
          visible.map((s) => {
            const Icon = s.icon;
            const isActive = activeSectionId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelect(s.id)}
                className={cn(
                  'relative flex items-center gap-2.5 w-full text-left rounded-sp-btn',
                  'text-sp-13 transition-all duration-150',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                  isActive
                    ? 'bg-sp-active text-sp-text font-semibold'
                    : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
                )}
                style={{ padding: '9px 12px 9px 14px' }}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sp-accent"
                    style={{ boxShadow: '0 0 8px var(--sp-accent-glow-55)' }}
                  />
                )}
                <Icon
                  size={14}
                  className={cn('transition-colors', isActive ? 'text-sp-accent' : 'text-sp-muted')}
                />
                <span>{s.label}</span>
              </button>
            );
          })
        )}
      </nav>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/settings/components/__tests__/SettingsSidebar.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/components/SettingsSearch.tsx \
  src/features/settings/components/SettingsSidebar.tsx \
  src/features/settings/components/__tests__/SettingsSidebar.test.tsx
git commit -m "feat(settings): add SettingsSidebar and SettingsSearch"
```

---

### Task 11: SettingsPage shell + route registration

**Files:**

- Create: `src/features/settings/SettingsPage.tsx`
- Modify: `src/App.tsx`
- Test: `src/features/settings/__tests__/SettingsPage.test.tsx`

**Interfaces:**

- Consumes: `SettingsSidebar` (Task 10), all 11 section components (Tasks 2–9), `SECTIONS`/`SectionId` from `../lib/sectionRegistry` (Task 1), `SubTabPanel` from `@/components/ui/spatial`.
- Produces: default-exported `SettingsPage` route element (no props — reads `:sectionId` via `useParams`), registered at `path: '/settings/:sectionId?'` in `App.tsx`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/features/settings/__tests__/SettingsPage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from '../SettingsPage';

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false), getElectronAPI: vi.fn(() => null) };
});
vi.mock('@/hooks/useStorageMonitor', () => ({
  useStorageMonitor: () => ({
    status: { totalRecords: 0, percentage: 0, level: 'ok', message: null },
    checkStorage: vi.fn(),
    formattedUsed: '0 B',
    formattedAvailable: '10 GB',
  }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/:sectionId?" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SettingsPage', () => {
  it('defaults to the General section when no sectionId is given', () => {
    renderAt('/settings');
    expect(screen.getAllByText('General').length).toBeGreaterThan(0);
  });

  it('deep-links directly into the requested section', () => {
    renderAt('/settings/certificates');
    expect(screen.getByRole('heading', { name: 'Certificates' })).toBeInTheDocument();
  });

  it('switches sections when a sidebar row is clicked', async () => {
    const user = userEvent.setup();
    renderAt('/settings/general');
    await user.click(screen.getByRole('tab', { name: /proxy/i }));
    expect(screen.getByRole('heading', { name: 'Proxy' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/__tests__/SettingsPage.test.tsx`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement `SettingsPage.tsx`** (header pattern mirrors `AiLabWorkspace.tsx:104-127`; content area replaces `SettingsDrawer.tsx:164-301`'s dialog chrome with a full-page layout)

```tsx
// src/features/settings/SettingsPage.tsx
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SubTabPanel } from '@/components/ui/spatial';
import { Logo } from '@/components/shared/Logo';
import { getPlatform, isElectron } from '@/lib/shared/platform';
import { SettingsSidebar } from './components/SettingsSidebar';
import { SECTIONS, type SectionId } from './lib/sectionRegistry';
import { AboutSection } from './sections/AboutSection';
import { AiSection } from './sections/AiSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { CertificatesSection } from './sections/CertificatesSection';
import { DataSection } from './sections/DataSection';
import { GeneralSection } from './sections/GeneralSection';
import { ProxySection } from './sections/ProxySection';
import { RequestsSection } from './sections/RequestsSection';
import { SecretsSection } from './sections/SecretsSection';
import { ShortcutsSection } from './sections/ShortcutsSection';
import { UpdatesSection } from './sections/UpdatesSection';

const SECTION_COMPONENTS: Record<SectionId, React.ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  requests: RequestsSection,
  proxy: ProxySection,
  certificates: CertificatesSection,
  secrets: SecretsSection,
  ai: AiSection,
  data: DataSection,
  updates: UpdatesSection,
  shortcuts: ShortcutsSection,
  about: AboutSection,
};

const VALID_SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

function isSectionId(value: string | undefined): value is SectionId {
  return !!value && VALID_SECTION_IDS.has(value);
}

// CSS-in-JS region tag — Electron-only `WebkitAppRegion`. Mirrors AiLabWorkspace
// so the Settings titlebar drags like the main window.
const region = (value: 'drag' | 'no-drag'): React.CSSProperties =>
  ({ WebkitAppRegion: value }) as React.CSSProperties;

export function SettingsPage() {
  const { sectionId } = useParams<{ sectionId?: string }>();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const activeSectionId: SectionId = isSectionId(sectionId) ? sectionId : 'general';
  const ActiveSection = SECTION_COMPONENTS[activeSectionId];

  const showTrafficLights = isElectron() && getPlatform() === 'darwin';

  return (
    <div className="flex h-screen flex-col text-sp-text">
      <header
        style={{ ...region('drag'), height: 44 }}
        className="flex shrink-0 select-none items-center gap-3 border-b border-sp-line bg-sp-surface px-3.5"
      >
        {showTrafficLights && (
          <span className="block shrink-0" style={{ width: 56 }} aria-hidden="true" />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          aria-label="Back to workspace"
          style={region('no-drag')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Logo size={20} />
        <h1 className="text-sp-14 font-semibold">Settings</h1>
        <span className="text-sp-12 text-sp-muted">Tune Restura to match how you work</span>
      </header>

      <div className="flex flex-1 min-h-0">
        <SettingsSidebar
          activeSectionId={activeSectionId}
          onSelect={(id) => navigate(`/settings/${id}`)}
          query={query}
          onQueryChange={setQuery}
        />
        <div className="flex-1 overflow-y-auto px-8 py-7">
          <div className="max-w-[720px]">
            <SubTabPanel tabKey={activeSectionId}>
              <ActiveSection />
            </SubTabPanel>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
```

- [ ] **Step 4: Register the route in `App.tsx`** (mirrors the existing `/ai-lab` lazy-route pattern at `App.tsx:25,33-37`)

```tsx
// src/App.tsx — add alongside the existing AiLabWorkspace lazy import
const SettingsPage = lazyComponent(() => import('@/features/settings/SettingsPage'));
```

```tsx
// src/App.tsx — add as a new route entry inside createHashRouter([...]), after '/ai-lab'
{
  path: '/settings/:sectionId?',
  element: <SettingsPage />,
  errorElement: <NotFound />,
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/__tests__/SettingsPage.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Type-check and commit**

Run: `npm run type-check`
Expected: no new errors

```bash
git add src/features/settings/SettingsPage.tsx \
  src/features/settings/__tests__/SettingsPage.test.tsx \
  src/App.tsx
git commit -m "feat(settings): add SettingsPage route shell and register /settings route"
```

---

### Task 12: Cut over entry points, delete the monolith, verify manually

**Files:**

- Modify: `src/routes/index.tsx`
- Delete: `src/components/shared/SettingsDrawer.tsx`
- Delete: `src/components/shared/__tests__/SettingsDrawer.test.tsx`

**Interfaces:**

- Consumes: `useNavigate` from `react-router-dom`; the `/settings/:sectionId?` route from Task 11.
- Produces: no new exports — this task only rewires existing trigger call sites and removes dead code.

- [ ] **Step 1: Update `src/routes/index.tsx` imports**

Remove:

```tsx
import SettingsDrawer, { type SectionId } from '@/components/shared/SettingsDrawer';
```

Add:

```tsx
import { useNavigate } from 'react-router-dom';
```

- [ ] **Step 2: Remove the drawer state and add `navigate`**

Remove (was `routes/index.tsx:73-74`):

```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId>('general');
```

Add, alongside the other hooks near the top of `Home()`:

```tsx
const navigate = useNavigate();
```

- [ ] **Step 3: Rewire the four trigger call sites**

Replace the `mod+,` and `mod+/` keybinding handlers (was `routes/index.tsx:190-205`):

```tsx
{
  combo: 'mod+,',
  allowInInput: true,
  handler: () => navigate('/settings/general'),
},
{
  combo: 'mod+/',
  allowInInput: true,
  handler: () => navigate('/settings/shortcuts'),
},
```

Replace the native menu handler (was `routes/index.tsx:230-239`):

```tsx
// Native "Settings/Preferences" menu item (Electron) → navigate to the
// Settings route. The mod+, keybinding above covers the web build, where
// there is no native menu.
useEffect(() => onMenuEvent('menu:settings', () => navigate('/settings/general')), [navigate]);
```

Replace the `TopBar` prop (was `routes/index.tsx:306-309`):

```tsx
onOpenSettings={() => navigate('/settings/general')}
```

Replace the `CommandPalette` prop (was `routes/index.tsx:363-366`):

```tsx
onOpenSettings={() => navigate('/settings/general')}
```

- [ ] **Step 4: Remove the `<SettingsDrawer>` render**

Remove (was `routes/index.tsx:371-375`):

```tsx
<SettingsDrawer
  open={settingsOpen}
  onOpenChange={setSettingsOpen}
  initialSection={settingsInitialSection}
/>
```

- [ ] **Step 5: Delete the monolith and its test**

```bash
git rm src/components/shared/SettingsDrawer.tsx
git rm src/components/shared/__tests__/SettingsDrawer.test.tsx
```

- [ ] **Step 6: Full verification**

Run: `npm run type-check:all`
Expected: no errors — confirms nothing outside `routes/index.tsx` still imports `SettingsDrawer` or `SectionId` from the old path

Run: `npx vitest run src/features/settings`
Expected: all settings tests PASS (Tasks 1–11 combined: ~25 tests)

Run: `npm run lint`
Expected: no new errors

- [ ] **Step 7: Manual verification pass (per spec §10 — UI changes must be exercised, not just unit-tested)**

Run: `npm run dev`, open the app in a browser, then:

- Press `⌘,` (or `Ctrl+,`) → confirm it navigates to `/settings/general` and the sidebar/search render correctly.
- Click a few sidebar sections; confirm the content pane cross-fades and the URL hash updates per section.
- Type into the search box; confirm the list filters and shows the empty state for a nonsense query.
- Open the AI section; confirm the desktop-only `DesktopOnlyBadge` fallback renders (web has no AI bundle).
- Click "Back to workspace"; confirm it returns to `/`.

Run: `npm run electron:dev`, then:

- Repeat the same checks; additionally confirm the AI section renders `ProviderSettings` + the Judge/scorer fields (not the fallback), and that macOS traffic-light spacing looks correct in the Settings header.

- [ ] **Step 8: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat(settings): cut over to /settings route, remove SettingsDrawer monolith"
```

---

## Self-Review

**1. Spec coverage** — every spec section has a corresponding task:

- §3 Container/Navigation/Search/Judge-move/AI-fallback/Code-structure/Entry-points decisions → Tasks 1, 8, 10, 11, 12.
- §4 Architecture (file tree, router entry, deletion) → Tasks 1–11 (files), Task 12 (router cutover + deletion).
- §5 Layout & visual system (flat sidebar, card content, `SubTabPanel` transition, accent) → Task 10 (sidebar), Task 11 (content pane + transition).
- §6 Section content plan (Judge moved) → Task 4 (Requests without Judge) + Task 8 (AI with Judge).
- §7 Search implementation → Task 1 (`filterSections`) + Task 10 (`SettingsSearch`/`SettingsSidebar`).
- §8 Data flow & state (URL param for section, local state for query) → Task 11.
- §9 Error handling (unknown section, AI web fallback, empty search, existing error states preserved) → Task 11 (`isSectionId` fallback to `'general'`), Task 8 (AI fallback), Task 10 (empty state), Tasks 2–9 (unchanged error states).
- §10 Testing → one test file per task, plus Task 12 Step 6–7 for the full suite + manual pass.
- §11 Migration notes (delete-and-replace, keep `ProviderSettings` lazy-loading, `capabilities.ts` untouched) → Task 8 (lazy wrapper preserved verbatim), Task 12 (deletion), no task touches `capabilities.ts`.

**2. Placeholder scan** — found one violation on first pass: Task 4's `UpdatesSection` code used stand-in wrapper names (`ToggleFieldForAutoUpdate`, `SegmentedForChannel`) with a callout explaining what to substitute, instead of the real code. Fixed inline: the code block now uses `ToggleField`/`Segmented<'stable' | 'beta'>` directly (matching `SettingsDrawer.tsx:1837-1857`) with `Segmented, ToggleField` added to the `@/components/ui/spatial` import, and the callout removed.

**3. Type consistency** — checked across tasks: `SectionId` is defined once in Task 1 (`lib/sectionRegistry.ts`) and imported everywhere else (Tasks 10, 11, 12) rather than redefined. `SECTION_COMPONENTS: Record<SectionId, React.ComponentType>` in Task 11 has exactly the 11 keys matching `SECTIONS` from Task 1. `DataButton` and `FieldGroup`/`FieldRow`/`SectionHeader`/`SectionLabel` are defined once (Task 1) and only ever imported, never redeclared, in Tasks 2–9.

No further gaps found; plan is ready for execution.
