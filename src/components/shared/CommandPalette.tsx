'use client';

import * as React from 'react';
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Search,
  Send,
  Settings2,
  Globe,
  Moon,
  Sun,
  Keyboard,
  Trash2,
  FolderOpen,
  Copy,
  Code2,
  FileCode2,
  Gauge,
  Check,
  Wifi,
  Server,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Kbd, MethodChip, ProtoChip } from '@/components/ui/spatial';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useUiStore } from '@/store/useUiStore';
import { useActiveResponse, useActiveTab } from '@/store/selectors';
import { cn } from '@/lib/shared/utils';
import { isElectron } from '@/lib/shared/platform';
import type { Collection, CollectionItem, RequestType } from '@/types';

interface CommandPaletteProps {
  onOpenEnvironments?: () => void;
  onOpenSettings?: () => void;
  onOpenImport?: () => void;
  onSendRequest?: () => void;
  // Widened to include `graphql` so the "New GraphQL request" command can
  // hand off to Home's `handleRequestModeChange`, which already understands
  // the full RequestMode union. The original narrower type omitted graphql
  // because graphql lives under modeOverride rather than as a tab type.
  onChangeMode?: (
    mode: 'http' | 'grpc' | 'websocket' | 'socketio' | 'sse' | 'mcp' | 'graphql' | 'kafka'
  ) => void;
  // Optional controlled mode — when both are provided the palette becomes
  // controlled (e.g. opened by the chrome Search pill). When omitted the
  // palette keeps its internal Cmd+K listener as the sole open source.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type ItemKind = 'request' | 'new' | 'action' | 'setting' | 'environment';

interface PaletteItem {
  id: string;
  kind: ItemKind;
  name: string;
  path?: string;
  /** When kind === 'request' */
  method?: string;
  /** When kind === 'new' */
  proto?: string;
  /** When kind === 'action' | 'setting' */
  icon?: LucideIcon;
  /** When kind === 'request' — flagged as recent */
  recent?: boolean;
  /** When kind === 'environment' — currently-active marker. */
  activeMarker?: boolean;
  shortcut?: string;
  group: 'Recent' | 'Requests' | 'Actions' | 'New' | 'Environments' | 'Settings';
  onSelect: () => void;
}

function flattenCollectionRequests(
  collection: Collection,
  out: Array<{ method: string; name: string; path: string; id: string }> = [],
  parentPath: string = ''
): Array<{ method: string; name: string; path: string; id: string }> {
  const here = parentPath ? `${parentPath} / ${collection.name}` : collection.name;
  const walk = (items: CollectionItem[] | undefined, prefix: string) => {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'folder') {
        walk(item.items, `${prefix} / ${item.name}`);
      } else if (item.type === 'request' && item.request) {
        const req = item.request;
        const method =
          'method' in req && typeof req.method === 'string' ? req.method : req.type.toUpperCase();
        out.push({
          id: item.id,
          name: item.name,
          path: prefix,
          method,
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
  const listRef = useRef<HTMLDivElement | null>(null);

  const { theme, setTheme } = useTheme();
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
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [setOpen]);

  // Reset transient state on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlighted(0);
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const run = useCallback(
    (cmd: () => void) => {
      close();
      cmd();
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
      const method =
        'method' in req && typeof req.method === 'string' ? req.method : req.type.toUpperCase();
      items.push({
        id: `recent-${h.id}`,
        kind: 'request',
        group: 'Recent',
        name: req.name || req.url || method,
        method,
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
        shortcut: '⌘↵',
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
        shortcut: '⌘⇧C',
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
    items.push({
      id: 'clear-history',
      kind: 'action',
      group: 'Actions',
      name: 'Clear history',
      icon: Trash2,
      onSelect: clearHistory,
    });

    // New group — Kafka is desktop-only (worker can't open raw TCP).
    const newProtos: Array<{
      proto: string;
      type: RequestType | 'websocket' | 'socketio' | 'graphql' | 'kafka';
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
        ? [{ proto: 'KAFKA', type: 'kafka' as const, label: 'New Kafka consumer' }]
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
          if (
            p.type === 'graphql' ||
            p.type === 'websocket' ||
            p.type === 'socketio' ||
            p.type === 'kafka'
          ) {
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
      name: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    });
    if (onOpenSettings) {
      items.push({
        id: 'open-settings',
        kind: 'setting',
        group: 'Settings',
        name: 'Open settings',
        icon: Settings2,
        shortcut: '⌘,',
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
    onChangeMode,
    currentResponse,
    clearHistory,
    createNewRequest,
    openTab,
    theme,
    setTheme,
  ]);

  // Filter
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => {
      const hay = `${it.name} ${it.path ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allItems, query]);

  // Group preserving original order
  const grouped = useMemo(() => {
    const order: Array<PaletteItem['group']> = [
      'Recent',
      'Requests',
      'Actions',
      'New',
      'Environments',
      'Settings',
    ];
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
        if (target) run(target.onSelect);
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
              placeholder="Search requests, actions, settings..."
              className="flex-1 bg-transparent outline-none text-sp-text placeholder:text-sp-dim text-sp-14"
              style={{ fontFamily: 'Geist, var(--font-sans, sans-serif)' }}
            />
            <Kbd size="xs">ESC</Kbd>
          </div>

          {/* List */}
          <div ref={listRef} className="flex-1 overflow-y-auto py-2" style={{ minHeight: 0 }}>
            {filtered.length === 0 ? (
              <div className="px-4 py-12 text-center text-sp-muted text-sp-12">
                No matches for &lsquo;{query}&rsquo;
              </div>
            ) : (
              grouped.map((g) => (
                <div key={g.group} className="mb-2 last:mb-0">
                  <div className="sp-label px-4 pt-2 pb-1">{g.group}</div>
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
                          onClick={() => run(it.onSelect)}
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
                <Kbd size="xs">⌘↵</Kbd>
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
  );
}

interface PaletteRowProps {
  item: PaletteItem;
  index: number;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}

const PROTO_ICON: Record<string, LucideIcon> = {
  WS: Wifi,
  SOCKETIO: Wifi,
  GRPC: Server,
  MCP: Server,
  SSE: Wifi,
  HTTP: Code2,
  GQL: Code2,
};

function PaletteRow({ item, index, active, onMouseEnter, onClick }: PaletteRowProps) {
  const Icon =
    item.icon ?? (item.kind === 'new' && item.proto ? PROTO_ICON[item.proto] : undefined);

  return (
    <div
      role="option"
      aria-selected={active}
      data-cmd-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-3 mx-2 px-3 py-2 rounded-sp-btn cursor-pointer',
        'text-sp-13 text-sp-text',
        active ? 'bg-sp-active' : 'hover:bg-sp-hover'
      )}
      style={active ? { boxShadow: 'inset 2px 0 0 0 var(--sp-accent)' } : undefined}
    >
      {/* Leading visual */}
      <div className="shrink-0 inline-flex items-center justify-center">
        {item.kind === 'request' && item.method ? (
          <MethodChip method={item.method} size="sm" />
        ) : item.kind === 'new' && item.proto ? (
          <ProtoChip protocol={item.proto} />
        ) : Icon ? (
          <Icon size={15} className="text-sp-muted" />
        ) : null}
      </div>

      {/* Name + path */}
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="truncate whitespace-nowrap text-sp-text font-medium">{item.name}</span>
        {item.path && (
          <span className="truncate text-sp-dim text-sp-11 font-mono">{item.path}</span>
        )}
      </div>

      {/* Trailing */}
      <div className="shrink-0 inline-flex items-center gap-2">
        {item.activeMarker && <Check size={13} className="text-sp-accent" />}
        {item.recent && (
          <span
            className="font-mono uppercase tracking-wide rounded-sp-chip px-1.5 py-0.5"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              background: 'var(--sp-accent-glow-15)',
              color: 'var(--sp-accent)',
            }}
          >
            RECENT
          </span>
        )}
        {item.shortcut && <Kbd size="xs">{item.shortcut}</Kbd>}
        {item.kind === 'action' && !item.shortcut && active && (
          <Keyboard size={12} className="text-sp-dim" />
        )}
      </div>
    </div>
  );
}
