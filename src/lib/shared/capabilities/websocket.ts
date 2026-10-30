// Capability rows: WebSocket.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const WEBSOCKET_CAPABILITIES = {
  'websocket.basic': { label: 'WebSocket connect', web: true, desktop: true },
  'websocket.customHeaders': {
    label: 'WebSocket custom request headers',
    web: false,
    desktop: true,
    notes:
      'Browser WS API forbids handshake headers; web connects directly and warns when headers would be dropped. The /api/ws-ticket → /api/ws Worker relay exists but is not wired into the renderer yet',
  },
  'websocket.viaWorkerProxy': {
    label: 'WS through Worker (SSRF gate, header policy)',
    web: false,
    desktop: false,
    notes:
      'Worker routes exist (/api/ws-ticket, /api/ws) but the web renderer connects directly via the browser WebSocket API (as do Socket.IO and GraphQL subscriptions), so an in-app check refuses loopback / private / cloud-metadata targets unless "Allow private / internal IPs" is on, and confirms before sending credentials over ws:// (#898); desktop uses Node ws with the DNS-pinned guard',
  },
  'websocket.ping': {
    label: 'WebSocket ping / pong frames (with RTT)',
    web: false,
    desktop: true,
    notes:
      'The browser WebSocket API exposes no ping/pong control frames; web disables the Ping control with an explanatory tooltip. Custom close code/reason and the negotiated subprotocol/extensions work on both',
  },
  'websocket.perMessageDeflateToggle': {
    label: 'Disable WebSocket permessage-deflate per connection',
    web: false,
    desktop: true,
    notes: 'The browser always negotiates compression itself; desktop can turn the offer off',
  },
} as const satisfies Record<string, CapabilityRow>;
