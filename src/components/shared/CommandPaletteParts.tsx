import { Check, Code2, Keyboard, type LucideIcon, Server, Wifi } from 'lucide-react';
import { Kbd, MethodChip, ProtoChip } from '@/components/ui/spatial';
import { isElectron, isMac } from '@/lib/shared/platform';
import { formatCombo, shortcutCombo } from '@/lib/shared/shortcuts';
import { cn } from '@/lib/shared/utils';

/** Row model, grouping and rendering for the command palette. */

export type ItemKind = 'request' | 'new' | 'action' | 'setting' | 'environment';

export interface PaletteItem {
  id: string;
  kind: ItemKind;
  name: string;
  path?: string;
  /** When kind === 'request' and the request is HTTP */
  method?: string;
  /** When kind === 'new', or kind === 'request' for non-HTTP protocols */
  proto?: string;
  /** When kind === 'action' | 'setting' */
  icon?: LucideIcon;
  /** When kind === 'request' — flagged as recent */
  recent?: boolean;
  /** When kind === 'environment' — currently-active marker. */
  activeMarker?: boolean;
  shortcut?: string;
  group: 'Recent' | 'Requests' | 'Actions' | 'New' | 'Environments' | 'Settings';
  /**
   * Leave the palette mounted after selecting — for actions that open their
   * own confirm dialog, which lives in (and unmounts with) the palette.
   */
  keepOpen?: boolean;
  onSelect: () => void;
}

export const GROUP_ORDER: ReadonlyArray<PaletteItem['group']> = [
  'Recent',
  'Requests',
  'Actions',
  'New',
  'Environments',
  'Settings',
];

export const LISTBOX_ID = 'command-palette-listbox';
export const optionId = (itemId: string) => `cmd-option-${itemId}`;

/** Shortcut label for a palette row, from the shared registry for this platform. */
export function hint(id: string): string | undefined {
  const combo = shortcutCombo(id, isElectron());
  return combo ? formatCombo(combo, isMac()).join(isMac() ? '' : '+') : undefined;
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

export function PaletteRow({ item, index, active, onMouseEnter, onClick }: PaletteRowProps) {
  const Icon =
    item.icon ?? (item.kind === 'new' && item.proto ? PROTO_ICON[item.proto] : undefined);

  return (
    <div
      id={optionId(item.id)}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      data-cmd-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'relative flex items-center gap-3 mx-2 px-3 py-2 rounded-sp-btn cursor-pointer',
        'text-sp-13 text-sp-text',
        active ? 'bg-sp-active' : 'hover:bg-sp-hover'
      )}
      style={active ? { boxShadow: 'inset 2px 0 0 0 var(--sp-accent)' } : undefined}
    >
      {/* Leading visual */}
      <div className="shrink-0 inline-flex items-center justify-center">
        {/* proto exists only on 'request' (non-HTTP) and 'new' items; method
            only on HTTP 'request' items — so a flat chain covers all kinds. */}
        {item.proto ? (
          <ProtoChip protocol={item.proto} />
        ) : item.method ? (
          <MethodChip method={item.method} size="sm" />
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
