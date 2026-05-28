import { Globe, Settings, Sparkles } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Floater, Kbd } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { isElectron, getPlatform } from '@/lib/shared/platform';
import { envColorFor } from '@/features/environments/lib/envColor';
import { envHostHint } from '@/features/environments/lib/envHint';
import type { RequestMode } from '@/types';

// Re-exported so existing callers (`import { envColorFor } from '@/components/shared/TopBar'`)
// keep working; the canonical home is `@/features/environments/lib/envColor`.
export { envColorFor };

// CSS-in-JS region tag — Electron-only `WebkitAppRegion: 'drag'` / 'no-drag'.
// React types don't include it natively; cast at usage site keeps it scoped.
type DragRegion = 'drag' | 'no-drag';
const region = (value: DragRegion): React.CSSProperties =>
  ({ WebkitAppRegion: value }) as React.CSSProperties;

interface WindowChromeProps {
  // Existing — preserved for the current Home orchestrator.
  requestMode?: RequestMode;
  onRequestModeChange?: (mode: RequestMode) => void;
  onOpenImport?: () => void;
  setEnvManagerOpen?: (open: boolean) => void;
  // New — wired by the orchestrator after refactor.
  onOpenCommandPalette?: () => void;
  onOpenSettings?: () => void;
  onOpenEnvSwitcher?: () => void;
  onToggleAi?: () => void;
}

/**
 * The application window chrome — 44px tall, edge-to-edge along the top.
 *
 * On macOS Electron we leave space for traffic lights (rendered as
 * non-functional placeholders; the OS draws the real controls over our
 * window when `frame:false` is set). Elsewhere the leftmost slot is empty.
 *
 * The component intentionally exposes the legacy `setEnvManagerOpen`,
 * `onOpenImport`, etc. props so existing call sites keep compiling — the
 * Home orchestrator will migrate to the new ones in a follow-up.
 */
export function WindowChrome({
  onOpenCommandPalette,
  onOpenSettings,
  onOpenEnvSwitcher,
  onToggleAi,
  setEnvManagerOpen,
}: WindowChromeProps) {
  const { environments, activeEnvironmentId } = useEnvironmentStore(
    useShallow((s) => ({
      environments: s.environments,
      activeEnvironmentId: s.activeEnvironmentId,
    }))
  );
  const activeEnv = activeEnvironmentId
    ? (environments.find((e) => e.id === activeEnvironmentId) ?? null)
    : null;

  const envName = activeEnv?.name ?? 'No environment';
  const envHost = envHostHint(activeEnv);
  const envColor = envColorFor(activeEnv);

  // The traffic-light placeholders are only visible to communicate "this is a
  // window" — real controls come from the OS when `frame:false` is configured.
  const showTrafficLights = isElectron() && getPlatform() === 'darwin';

  // Legacy callbacks fall back gracefully — if the orchestrator hasn't
  // wired the new prop, we surface the old behaviour. This keeps the prop
  // contract additive.
  const handleOpenEnv = onOpenEnvSwitcher ?? (() => setEnvManagerOpen?.(true));

  return (
    <header
      role="banner"
      aria-label="Application chrome"
      style={{ ...region('drag'), height: 44, padding: '0 14px' }}
      className={cn(
        'relative flex items-center shrink-0 select-none',
        'bg-sp-surface border-b border-sp-line text-sp-text'
      )}
    >
      {/* Left: traffic-light slot + brand */}
      <div className="flex items-center gap-3">
        {showTrafficLights ? (
          <div className="flex items-center gap-2" aria-hidden="true">
            <span className="block size-3 rounded-full" style={{ background: '#ff5f57' }} />
            <span className="block size-3 rounded-full" style={{ background: '#febc2e' }} />
            <span className="block size-3 rounded-full" style={{ background: '#28c840' }} />
          </div>
        ) : (
          <span className="block w-1" aria-hidden="true" />
        )}
        <span className="font-mono text-sp-12 text-sp-muted tracking-tight">Restura</span>
      </div>

      {/* Center: environment pill — absolutely positioned so it stays centered
          regardless of how wide the left/right slots grow. */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={region('no-drag')}
      >
        <button
          type="button"
          onClick={handleOpenEnv}
          aria-label={`Switch environment (current: ${envName})`}
          className={cn(
            'inline-flex items-center gap-2 h-7 px-2.5 rounded-sp-pill',
            'bg-sp-surface-lo border border-sp-line',
            'font-mono text-sp-11 text-sp-muted',
            'hover:bg-sp-hover hover:text-sp-text transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <Globe className="h-3 w-3" aria-hidden="true" />
          {envHost && (
            <>
              <span className="text-sp-text/80 truncate max-w-[220px]">{envHost}</span>
              <span className="text-sp-dim" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: activeEnv ? envColor : 'var(--sp-text-muted)' }}
          >
            <span
              className="block size-1.5 rounded-full"
              style={{ background: 'currentColor' }}
              aria-hidden="true"
            />
            {envName}
          </span>
        </button>
      </div>

      {/* Right: search trigger + settings */}
      <div className="ml-auto flex items-center gap-1.5" style={region('no-drag')}>
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          className={cn(
            'inline-flex items-center gap-2 h-7 pl-2.5 pr-1.5 rounded-sp-pill',
            'bg-sp-surface-lo border border-sp-line',
            'font-mono text-sp-11-5 text-sp-muted',
            'hover:bg-sp-hover hover:text-sp-text transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <span>Search</span>
          <Kbd size="xs">⌘K</Kbd>
        </button>

        {onToggleAi && (
          <ChromeIconButton
            label="Toggle AI chat"
            onClick={onToggleAi}
            icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        )}
        <ChromeIconButton
          label="Open settings"
          onClick={onOpenSettings}
          icon={<Settings className="h-3.5 w-3.5" aria-hidden="true" />}
        />
      </div>
    </header>
  );
}

interface ChromeIconButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
}

/**
 * Small icon-only chrome button (30×30) used in the right cluster.
 */
function ChromeIconButton({ label, icon, onClick }: ChromeIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center size-[30px] rounded-sp-btn',
        'text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
      )}
    >
      {icon}
    </button>
  );
}

// Default-export wrapper keeps the existing `import TopBar from '...'`
// call site (in src/routes/index.tsx) compiling without churn — the
// orchestrator owns when it moves to `WindowChrome` directly.
export default function TopBar(props: WindowChromeProps) {
  return <WindowChrome {...props} />;
}

// Re-export the Floater so consumers that need to compose around the chrome
// don't have to reach across the alias barrel.
export { Floater };
