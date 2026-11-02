/**
 * Data-only descriptor for every workspace `RequestMode`.
 *
 * One entry per mode, in new-request menu order. Everything the shell needs to
 * list, label, gate or seed a mode lives here so adding a mode is one entry,
 * not a hunt across the tab strip, palette, empty state and store. The
 * `Record` over the union makes a missing entry a compile error — same
 * technique as `isConnectionMode` (`shared/types/request.ts`).
 *
 * Deliberately NOT here: React panes (they must stay lazy in the route),
 * Request factories and per-mode URL readers (they pull in stores/builders).
 * Keep this module's imports type-only so it never drags a chunk into the
 * initial bundle.
 *
 * `RequestType` vs `RequestMode`/`modeOverride` (ADR-0002) is a separate
 * concern; this descriptor is keyed by `RequestMode` only.
 */
import type { ProtocolName } from '@/components/ui/spatial/ProtoChip';
import type { CapabilityName } from '@/lib/shared/capabilities';
import type { RequestMode } from '@/types';

export interface ModeDescriptor {
  /** Short label (empty-state and welcome buttons). */
  label: string;
  /** Label in the tab strip's "+" menu and "Open as…" submenu. */
  menuLabel: string;
  /** Command-palette "New" entry label. */
  commandLabel: string;
  /** Command-palette "New" group position (ascending). */
  commandRank: number;
  /** Protocol chip text. */
  chip: ProtocolName;
  /** Needs the desktop app (raw TCP); shown disabled + badged on web. */
  desktopOnly?: boolean;
  /** Capability row whose notes explain the desktop-only gating. */
  capability?: CapabilityName;
  /** True when "Open as…" can carry a URL onto the new tab (see `openAs.ts`). */
  carriesUrl: boolean;
  /**
   * Overrides applied to the HTTP placeholder request when opening a
   * `modeOverride` tab of this mode (GraphQL rides an HTTP-shaped request).
   */
  httpSeed?: { name: string; method: 'POST'; bodyType: 'graphql' };
  /** Collection runner can drive a single-shot `runRequest` (not a stream). */
  runnable: boolean;
  /** Runner stops before sending when a pre-request script calls `skipRequest()`. */
  honorsSkipRequest: boolean;
}

export const MODE_DESCRIPTORS: Record<RequestMode, ModeDescriptor> = {
  http: {
    label: 'HTTP',
    menuLabel: 'HTTP request',
    commandLabel: 'New HTTP request',
    commandRank: 0,
    chip: 'HTTP',
    carriesUrl: true,
    runnable: true,
    honorsSkipRequest: true,
  },
  graphql: {
    label: 'GraphQL',
    menuLabel: 'GraphQL request',
    commandLabel: 'New GraphQL request',
    commandRank: 2,
    chip: 'GQL',
    carriesUrl: true,
    httpSeed: { name: 'New GraphQL Request', method: 'POST', bodyType: 'graphql' },
    runnable: true,
    honorsSkipRequest: false,
  },
  grpc: {
    label: 'gRPC',
    menuLabel: 'gRPC request',
    commandLabel: 'New gRPC request',
    commandRank: 1,
    chip: 'GRPC',
    carriesUrl: true,
    runnable: true,
    honorsSkipRequest: true,
  },
  websocket: {
    label: 'WebSocket',
    menuLabel: 'WebSocket',
    commandLabel: 'New WS',
    commandRank: 3,
    chip: 'WS',
    carriesUrl: true,
    runnable: false,
    honorsSkipRequest: false,
  },
  socketio: {
    label: 'Socket.IO',
    menuLabel: 'Socket.IO',
    commandLabel: 'New Socket.IO',
    commandRank: 4,
    chip: 'SOCKETIO',
    carriesUrl: true,
    runnable: false,
    honorsSkipRequest: false,
  },
  sse: {
    label: 'SSE',
    menuLabel: 'SSE stream',
    commandLabel: 'New SSE stream',
    commandRank: 5,
    chip: 'SSE',
    carriesUrl: true,
    runnable: false,
    honorsSkipRequest: false,
  },
  mcp: {
    label: 'MCP',
    menuLabel: 'MCP request',
    commandLabel: 'New MCP request',
    commandRank: 6,
    chip: 'MCP',
    carriesUrl: true,
    runnable: true,
    honorsSkipRequest: true,
  },
  kafka: {
    label: 'Kafka',
    menuLabel: 'Kafka client',
    commandLabel: 'New Kafka client',
    commandRank: 7,
    chip: 'KAFKA',
    desktopOnly: true,
    capability: 'kafka.basic',
    carriesUrl: false,
    runnable: false,
    honorsSkipRequest: false,
  },
  mqtt: {
    label: 'MQTT',
    menuLabel: 'MQTT client',
    commandLabel: 'New MQTT client',
    commandRank: 8,
    chip: 'MQTT',
    desktopOnly: true,
    capability: 'mqtt.basic',
    carriesUrl: false,
    runnable: true,
    honorsSkipRequest: false,
  },
};

/** Modes in new-request menu order (the `MODE_DESCRIPTORS` key order). */
export const MODES_IN_MENU_ORDER = Object.keys(MODE_DESCRIPTORS) as RequestMode[];

/** Modes in command-palette "New" group order. */
export const MODES_IN_COMMAND_ORDER: RequestMode[] = [...MODES_IN_MENU_ORDER].sort(
  (a, b) => MODE_DESCRIPTORS[a].commandRank - MODE_DESCRIPTORS[b].commandRank
);

/**
 * Collection-run traits for a Request's protocol id. A protocol with no mode
 * entry reads as runnable and not honouring skipRequest: the runner's own
 * unknown-protocol check handles it.
 */
export function protocolRunTraits(
  protocolId: string
): Pick<ModeDescriptor, 'runnable' | 'honorsSkipRequest'> {
  return Object.hasOwn(MODE_DESCRIPTORS, protocolId)
    ? MODE_DESCRIPTORS[protocolId as RequestMode]
    : { runnable: true, honorsSkipRequest: false };
}
