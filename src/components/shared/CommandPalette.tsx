'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Columns,
  Copy,
  FileCode2,
  FolderOpen,
  Gauge,
  Globe,
  Keyboard,
  Moon,
  PanelLeft,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Sun,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GROUP_ORDER,
  hint,
  LISTBOX_ID,
  optionId,
  type PaletteItem,
  PaletteRow,
} from '@/components/shared/CommandPaletteParts';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { CLOSE_ACTIVE_TAB_EVENT } from '@/components/shared/TabBar';
import { REPLAY_ONBOARDING_EVENT } from '@/components/shared/WelcomeOnboarding';
import { Kbd } from '@/components/ui/spatial';
import { fuzzyScore } from '@/lib/shared/fuzzy';
import { isElectron } from '@/lib/shared/platform';
import { modLabel } from '@/lib/shared/shortcuts';
import { cn } from '@/lib/shared/utils';
import { withViewTransition } from '@/lib/shared/viewTransition';
import { useActiveResponse, useActiveTab } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useUiStore } from '@/store/useUiStore';
import type { Collection, CollectionItem, RequestType } from '@/types';
import { isConnectionMode } from '@/types';

interface CommandPaletteProps {
  onOpenEnvironments?: () => void;
  onOpenSettings?: () => void;
  onOpenShortcuts?: () => void;
  onOpenImport?: () => void;
  onSendRequest?: () => void;
  // Widened to include `graphql` so the "New GraphQL request" command can
  // hand off to Home's `handleRequestModeChange`, which already understands
  // the full RequestMode union. The original narrower type omitted graphql
  // because graphql lives under modeOverride rather than as a tab type.
  onChangeMode?: (
    mode: 'http' | 'grpc' | 'websocket' | 'socketio' | 'sse' | 'mcp' | 'graphql' | 'kafka' | 'mqtt'
  ) => void;
  // Optional controlled mode — when both are provided the palette becomes
  // controlled (e.g. opened by the chrome Search pill). When omitted the
  // palette keeps its internal Cmd+K listener as the sole open source.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Leading chip for a request row: HTTP requests show their verb (GET/POST/…);
 * every other protocol shows its ProtoChip — an HTTP MethodChip on a gRPC or
 * WebSocket entry would be wrong (and used to render a misleading "GET").
 */
function chipForRequest(req: { type: RequestType; method?: unknown }): {
  method?: string;
  proto?: string;
} {
  if (req.type === 'http' && typeof req.method === 'string') {
    return { method: req.method };
  }
  return { proto: req.type };
}

function flattenCollectionRequests(
  collection: Collection,
  out: Array<{ method?: string; proto?: string; name: string; path: string; id: string }> = [],
  parentPath: string = ''
): Array<{ method?: string; proto?: string; name: string; path: string; id: string }> {
  const here = parentPath ? `${parentPath} / ${collection.name}` : collection.name;
  const walk = (items: CollectionItem[] | undefined, prefix: string) => {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'folder') {
        walk(item.items, `${prefix} / ${item.name}`);
      } else if (item.type === 'request' && item.request) {
        out.push({
          id: item.id,
          name: item.name,
          path: prefix,
          ...chipForRequest(item.request),
        });
      }
    }
  };
  walk(collection.items, here);
  return out;
}

export default function CommandPalette({
  onOpenEnvironments,
  onOpenSettings,
  onOpenShortcuts,
  onOpenImport,
  onSendRequest,
  onChangeMode,
  open: openProp,
  onOpenChange,
}: CommandPaletteProps) {
  const [openInternal, setOpenInternal] = useState(false);
  const isControlled = openProp !== undefined && onOpenChange !== undefined;
  const open = isControlled ? openProp : openInternal;
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      if (isControlled) {
        const resolved = typeof next === 'function' ? next(openProp) : next;
        onOpenChange(resolved);
      } else {
        setOpenInternal(next);
      }
    },
    [isControlled, onOpenChange, openProp]
  );
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // resolvedTheme (concrete 'light'|'dark'), not theme — theme can be 'system',
  // which would make the binary toggle mislabel and no-op on first click.
  const { resolvedTheme, setTheme } = useTheme();
  const updateThemeSetting = useSettingsStore((s) => s.updateSettings);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);
  const openTab = useRequestStore((s) => s.openTab);
  const collections = useCollectionStore((s) => s.collections);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const history = useHistoryStore((s) => s.history);
  const environments = useEnvironmentStore((s) => s.environments);
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useEnvironmentStore((s) => s.setActiveEnvironment);
  const currentResponse = useActiveResponse();
  const activeTab = useActiveTab();
  // A WS/Socket.IO/Kafka/GraphQL tab is a placeholder type:'http' tab with a
  // modeOverride; in those modes RequestBuilder (which hosts the code-gen /
  // load-test dialogs) isn't mounted, so gate on the effective mode.
  const activeIsHttp = !activeTab?.modeOverride && activeTab?.request?.type === 'http';

  // Toggle ⌘K / Ctrl+K — works regardless of controlled/uncontrolled mode.
  useEffect(() => {
    if (isControlled) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [isControlled, setOpen]);

  // Reset transient state on open; drop a pending confirm when the palette
  // closes by any route (e.g. its own Cmd+K toggle) so it can't be orphaned.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlighted(0);
    } else {
      setConfirmClearOpen(false);
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const run = useCallback(
    (item: PaletteItem) => {
      if (!item.keepOpen) close();
      item.onSelect();
    },
    [close]
  );

  // Recent request IDs (history is most-recent-first)
  const recentRequestIds = useMemo(() => {
    const seen = new Set<string>();
    for (const h of history.slice(0, 8)) seen.add(h.request.id);
    return seen;
  }, [history]);

  // Build full item list
  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // Recent group — quick reopen of the last few executed requests. Distinct
    // from the RECENT badge in Requests: these come straight from history and
    // open the exact request that ran (even if not saved to a collection).
    const seenRecent = new Set<string>();
    for (const h of history) {
      if (seenRecent.has(h.request.id)) continue;
      seenRecent.add(h.request.id);
      const req = h.request;
      const chip = chipForRequest(req);
      items.push({
        id: `recent-${h.id}`,
        kind: 'request',
        group: 'Recent',
        name: req.name || req.url || chip.method || req.type.toUpperCase(),
        ...chip,
        onSelect: () => openTab(req, { switchTo: true }),
      });
      if (seenRecent.size >= 5) break;
    }

    // Requests group — flattened from collections
    for (const collection of collections) {
      const flat = flattenCollectionRequests(collection);
      for (const r of flat) {
        items.push({
          id: `req-${r.id}`,
          kind: 'request',
          group: 'Requests',
          name: r.name,
          path: r.path,
          method: r.method,
          proto: r.proto,
          recent: recentRequestIds.has(r.id),
          onSelect: () => {
            // Best-effort tab open: locate the original item with its request payload
            for (const c of collections) {
              const stack: CollectionItem[] = [...(c.items ?? [])];
              while (stack.length) {
                const it = stack.pop()!;
                if (it.type === 'folder') {
                  stack.push(...(it.items ?? []));
                } else if (it.id === r.id && it.request) {
                  openTab(it.request, { savedRequestId: it.id, switchTo: true });
                  return;
                }
              }
            }
          },
        });
      }
    }

    // Actions group
    if (onSendRequest) {
      items.push({
        id: 'send',
        kind: 'action',
        group: 'Actions',
        name: 'Send request',
        icon: Send,
        shortcut: hint('send'),
        onSelect: onSendRequest,
      });
    }
    if (currentResponse) {
      items.push({
        id: 'copy-response',
        kind: 'action',
        group: 'Actions',
        name: 'Copy response body',
        icon: Copy,
        onSelect: () => navigator.clipboard.writeText(currentResponse.body),
      });
    }
    if (activeIsHttp) {
      items.push({
        id: 'generate-code',
        kind: 'action',
        group: 'Actions',
        name: 'Generate code for current request',
        icon: FileCode2,
        onSelect: () => useUiStore.getState().setCodeGenOpen(true),
      });
      items.push({
        id: 'load-test',
        kind: 'action',
        group: 'Actions',
        name: 'Run load test on current request',
        icon: Gauge,
        onSelect: () => useUiStore.getState().setLoadTestOpen(true),
      });
    }
    if (onOpenImport) {
      items.push({
        id: 'import',
        kind: 'action',
        group: 'Actions',
        name: 'Import collection',
        icon: FolderOpen,
        onSelect: onOpenImport,
      });
    }
    if (activeTab) {
      items.push({
        id: 'close-tab',
        kind: 'action',
        group: 'Actions',
        name: 'Close tab',
        icon: X,
        shortcut: hint('close-tab'),
        onSelect: () => window.dispatchEvent(new Event(CLOSE_ACTIVE_TAB_EVENT)),
      });
      items.push({
        id: 'duplicate-tab',
        kind: 'action',
        group: 'Actions',
        name: 'Duplicate tab',
        icon: Copy,
        onSelect: () => useRequestStore.getState().duplicateTab(activeTab.id),
      });
    }
    items.push({
      id: 'reopen-tab',
      kind: 'action',
      group: 'Actions',
      name: 'Reopen closed tab',
      icon: RotateCcw,
      shortcut: hint('reopen-tab'),
      onSelect: () => useRequestStore.getState().reopenClosedTab(),
    });
    items.push({
      id: 'toggle-sidebar',
      kind: 'action',
      group: 'Actions',
      name: 'Toggle sidebar',
      icon: PanelLeft,
      shortcut: hint('toggle-sidebar'),
      onSelect: () => {
        const settings = useSettingsStore.getState();
        settings.updateSettings({ sidebarCollapsed: !settings.settings.sidebarCollapsed });
      },
    });
    items.push({
      id: 'toggle-layout',
      kind: 'action',
      group: 'Actions',
      name: 'Toggle side-by-side / stacked layout',
      icon: Columns,
      onSelect: () => {
        const settings = useSettingsStore.getState();
        settings.updateSettings({
          layoutOrientation:
            settings.settings.layoutOrientation === 'vertical' ? 'horizontal' : 'vertical',
        });
      },
    });
    items.push({
      id: 'toggle-console',
      kind: 'action',
      group: 'Actions',
      name: 'Toggle network console',
      icon: Terminal,
      shortcut: hint('toggle-console'),
      onSelect: () => {
        const consoleState = useConsoleStore.getState();
        consoleState.setExpanded(!consoleState.isExpanded);
      },
    });
    items.push({
      id: 'clear-history',
      kind: 'action',
      group: 'Actions',
      name: 'Clear history',
      icon: Trash2,
      keepOpen: true,
      onSelect: () => setConfirmClearOpen(true),
    });

    // New group — Kafka and MQTT are desktop-only (worker can't open raw TCP).
    const newProtos: Array<{
      proto: string;
      type: RequestType | 'websocket' | 'socketio' | 'graphql' | 'kafka' | 'mqtt';
      label: string;
    }> = [
      { proto: 'HTTP', type: 'http', label: 'New HTTP request' },
      { proto: 'GRPC', type: 'grpc', label: 'New gRPC request' },
      { proto: 'GQL', type: 'graphql', label: 'New GraphQL request' },
      { proto: 'WS', type: 'websocket', label: 'New WS' },
      { proto: 'SOCKETIO', type: 'socketio', label: 'New Socket.IO' },
      { proto: 'SSE', type: 'sse', label: 'New SSE stream' },
      { proto: 'MCP', type: 'mcp', label: 'New MCP request' },
      ...(isElectron()
        ? [
            { proto: 'KAFKA', type: 'kafka' as const, label: 'New Kafka client' },
            { proto: 'MQTT', type: 'mqtt' as const, label: 'New MQTT client' },
          ]
        : []),
    ];
    for (const p of newProtos) {
      items.push({
        id: `new-${p.type}`,
        kind: 'new',
        group: 'New',
        name: p.label,
        proto: p.proto,
        onSelect: () => {
          if (isConnectionMode(p.type)) {
            onChangeMode?.(p.type);
          } else {
            createNewRequest(p.type);
          }
        },
      });
    }

    // Environments group — switch the active environment without opening the
    // manager. Includes a "No environment" entry to clear the selection.
    if (environments.length > 0) {
      items.push({
        id: 'env-none',
        kind: 'environment',
        group: 'Environments',
        name: 'No environment',
        icon: Globe,
        activeMarker: activeEnvironmentId === null,
        onSelect: () => setActiveEnvironment(null),
      });
      for (const env of environments) {
        items.push({
          id: `env-${env.id}`,
          kind: 'environment',
          group: 'Environments',
          name: env.name,
          icon: Globe,
          activeMarker: env.id === activeEnvironmentId,
          onSelect: () => setActiveEnvironment(env.id),
        });
      }
    }

    // Settings group
    items.push({
      id: 'toggle-theme',
      kind: 'setting',
      group: 'Settings',
      name: resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: resolvedTheme === 'dark' ? Sun : Moon,
      onSelect: () =>
        withViewTransition(() => {
          const next = resolvedTheme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          // Keep the Dexie-persisted settings copy in sync with next-themes so
          // the two storage sources don't diverge (matches SettingsDrawer).
          updateThemeSetting({ theme: next });
        }),
    });
    if (onOpenShortcuts) {
      items.push({
        id: 'shortcuts',
        kind: 'setting',
        group: 'Settings',
        name: 'Keyboard shortcuts',
        icon: Keyboard,
        shortcut: hint('shortcuts'),
        onSelect: onOpenShortcuts,
      });
    }
    items.push({
      id: 'welcome-tour',
      kind: 'setting',
      group: 'Settings',
      name: 'Show welcome tour',
      icon: Rocket,
      onSelect: () => window.dispatchEvent(new Event(REPLAY_ONBOARDING_EVENT)),
    });
    if (onOpenSettings) {
      items.push({
        id: 'open-settings',
        kind: 'setting',
        group: 'Settings',
        name: 'Open settings',
        icon: Settings2,
        shortcut: hint('settings'),
        onSelect: onOpenSettings,
      });
    }
    if (onOpenEnvironments) {
      items.push({
        id: 'manage-envs',
        kind: 'setting',
        group: 'Settings',
        name: 'Manage environments',
        icon: Globe,
        onSelect: onOpenEnvironments,
      });
    }

    return items;
  }, [
    collections,
    recentRequestIds,
    history,
    environments,
    activeEnvironmentId,
    setActiveEnvironment,
    activeIsHttp,
    onSendRequest,
    onOpenImport,
    onOpenEnvironments,
    onOpenSettings,
    onOpenShortcuts,
    onChangeMode,
    currentResponse,
    activeTab,
    createNewRequest,
    openTab,
    resolvedTheme,
    setTheme,
    updateThemeSetting,
  ]);

  // Filter
  // Fuzzy match, best first *within* each group: rows render grouped, and
  // keyboard selection indexes into this list, so its order must match the
  // on-screen order.
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const scored: Array<{ it: PaletteItem; score: number; i: number }> = [];
    allItems.forEach((it, i) => {
      const score = fuzzyScore(query, `${it.name} ${it.path ?? ''}`);
      if (score !== null) scored.push({ it, score, i });
    });
    scored.sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.it.group) - GROUP_ORDER.indexOf(b.it.group) ||
        b.score - a.score ||
        a.i - b.i
    );
    return scored.map((s) => s.it);
  }, [allItems, query]);

  // Group preserving original order
  const grouped = useMemo(() => {
    const order = GROUP_ORDER;
    const map = new Map<PaletteItem['group'], PaletteItem[]>();
    for (const g of order) map.set(g, []);
    for (const it of filtered) map.get(it.group)?.push(it);
    return order
      .map((g) => ({ group: g, items: map.get(g) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  // Reset highlighted on filter change
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Keep highlighted in range
  useEffect(() => {
    if (highlighted >= filtered.length && filtered.length > 0) setHighlighted(filtered.length - 1);
  }, [filtered.length, highlighted]);

  // Keyboard navigation
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((h) => Math.min(filtered.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[highlighted];
        if (target) run(target);
      }
    },
    [filtered, highlighted, run]
  );

  // Scroll the highlighted row into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-index="${highlighted}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <>
      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={(next) => {
          setConfirmClearOpen(next);
          if (!next) close();
        }}
        title="Clear history?"
        description="This permanently removes every entry from your request history."
        confirmText="Clear history"
        variant="destructive"
        onConfirm={clearHistory}
      />
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
            )}
            style={{
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
            }}
          />
          <DialogPrimitive.Content
            aria-label="Command palette"
            onKeyDown={onKeyDown}
            className={cn(
              'fixed left-1/2 z-50 -translate-x-1/2',
              'w-[640px] max-w-[calc(100vw-32px)]',
              'rounded-sp-panel border border-sp-line-strong',
              'sp-floater-lg',
              'flex flex-col overflow-hidden',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
            )}
            style={{
              top: 100,
              maxHeight: 480,
              background: 'var(--sp-surface-hi)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            }}
          >
            <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Search for requests, actions, or settings
            </DialogPrimitive.Description>

            {/* Header */}
            <div
              className="flex items-center gap-3 border-b border-sp-line"
              style={{ padding: '14px 16px' }}
            >
              <Search size={15} className="text-sp-dim shrink-0" aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                role="combobox"
                aria-expanded={filtered.length > 0}
                aria-controls={LISTBOX_ID}
                aria-autocomplete="list"
                {...(filtered[highlighted] && {
                  'aria-activedescendant': optionId(filtered[highlighted].id),
                })}
                aria-label="Search requests, actions, settings"
                placeholder="Search requests, actions, settings..."
                className="flex-1 bg-transparent outline-none text-sp-text placeholder:text-sp-dim text-sp-14"
                style={{ fontFamily: 'Geist, var(--font-sans, sans-serif)' }}
              />
              <Kbd size="xs">ESC</Kbd>
            </div>

            {/* List */}
            <div
              ref={listRef}
              id={LISTBOX_ID}
              role="listbox"
              aria-label="Results"
              className="flex-1 overflow-y-auto py-2"
              style={{ minHeight: 0 }}
            >
              {filtered.length === 0 ? (
                <div className="px-4 py-12 text-center text-sp-muted text-sp-12">
                  No matches for &lsquo;{query}&rsquo;
                </div>
              ) : (
                grouped.map((g) => (
                  <div
                    key={g.group}
                    role="group"
                    aria-labelledby={`cmd-group-${g.group}`}
                    className="mb-2 last:mb-0"
                  >
                    <div id={`cmd-group-${g.group}`} className="sp-label px-4 pt-2 pb-1">
                      {g.group}
                    </div>
                    <div>
                      {g.items.map((it) => {
                        const globalIndex = filtered.indexOf(it);
                        const active = globalIndex === highlighted;
                        return (
                          <PaletteRow
                            key={it.id}
                            item={it}
                            index={globalIndex}
                            active={active}
                            onMouseEnter={() => setHighlighted(globalIndex)}
                            onClick={() => run(it)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-sp-line px-4 py-2 text-sp-11 text-sp-muted">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <Kbd size="xs">↑</Kbd>
                  <Kbd size="xs">↓</Kbd>
                  <span>navigate</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd size="xs">↵</Kbd>
                  <span>select</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd size="xs">{modLabel('↵')}</Kbd>
                  <span>in new tab</span>
                </span>
              </div>
              <div className="font-mono tabular-nums text-sp-dim">
                {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
