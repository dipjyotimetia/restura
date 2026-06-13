import { useMemo } from 'react';
import { Zap } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { Kbd } from '@/components/ui/spatial';
import { envColorFor } from '@/components/shared/TopBar';
import { cn } from '@/lib/shared/utils';

interface StatusBarProps {
  // Optional — orchestrator wires this when migrating to the new chrome.
  // Falls back to the legacy `⌘K` keyboard-event dispatch so the bar still
  // works as a standalone surface during the migration window.
  onOpenCommandPalette?: () => void;
}

/**
 * Hex with alpha helper. Returns `#rrggbbaa` for an 8-bit alpha value.
 * Used to derive the env-dot halo from the env's solid colour without
 * importing a colour library.
 */
function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(alpha)));
  const a = clamped.toString(16).padStart(2, '0');
  return `${hex}${a}`;
}

/**
 * Bottom status bar — 28px, hairline border-top, all mono 11.
 *
 * Left cluster:  env dot + name · ⚡ + today's request count · "Auto-save"
 * Right cluster: version · ⌘K Palette
 *
 * Heavy state (active env, history count) reads through Zustand selectors so
 * the bar stays cheap to re-render — no per-second tickers, no resize listeners.
 */
export default function StatusBar({ onOpenCommandPalette }: StatusBarProps = {}) {
  const { environments, activeEnvironmentId } = useEnvironmentStore(
    useShallow((s) => ({
      environments: s.environments,
      activeEnvironmentId: s.activeEnvironmentId,
    }))
  );
  const activeEnv = activeEnvironmentId
    ? (environments.find((e) => e.id === activeEnvironmentId) ?? null)
    : null;

  // Today's request count, computed as a derived selector. We resolve the
  // boundary once at component init — close enough for a status bar and
  // avoids a tick every render.
  const todayCount = useHistoryStore((state) => {
    const today = new Date().toDateString();
    return state.history.filter((h) => new Date(h.timestamp).toDateString() === today).length;
  });

  const envColor = envColorFor(activeEnv);
  const envName = activeEnv?.name ?? 'No environment';

  const version = useMemo(() => {
    const v = import.meta.env.VITE_APP_VERSION;
    return v && typeof v === 'string' ? (v.startsWith('v') ? v : `v${v}`) : 'v1.0.0';
  }, []);

  const triggerPaletteFallback = () => {
    // Legacy bridge — Home installs a global keydown listener for ⌘K, so
    // dispatching a synthetic event is enough while the new prop migrates in.
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
  };

  const handlePalette = onOpenCommandPalette ?? triggerPaletteFallback;

  return (
    <footer
      role="status"
      aria-live="polite"
      aria-label="Application status bar"
      className={cn(
        'flex items-center justify-between shrink-0 select-none',
        'h-7 border-t border-sp-line',
        'sp-chrome text-sp-muted font-mono text-sp-11'
      )}
      style={{ padding: '0 16px' }}
    >
      {/* Left cluster */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className="block size-1.5 rounded-full shrink-0"
            style={{
              background: envColor,
              boxShadow: `0 0 0 3px ${withAlpha(envColor, 0x33)}`,
            }}
          />
          <span className="truncate text-sp-text/80">{envName}</span>
        </div>

        <span className="text-sp-dim" aria-hidden="true">
          ·
        </span>

        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3" aria-hidden="true" />
          <span>
            {todayCount} {todayCount === 1 ? 'request' : 'requests'}
          </span>
        </div>

        <span className="text-sp-dim" aria-hidden="true">
          ·
        </span>

        <span>Auto-save</span>
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-3">
        <span>{version}</span>
        <span className="text-sp-dim" aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          onClick={handlePalette}
          aria-label="Open command palette"
          className={cn(
            'inline-flex items-center gap-1.5',
            'text-sp-muted hover:text-sp-text transition-colors',
            'focus:outline-none focus-visible:text-sp-text'
          )}
        >
          <Kbd size="xs">⌘K</Kbd>
          <span>Palette</span>
        </button>
      </div>
    </footer>
  );
}
