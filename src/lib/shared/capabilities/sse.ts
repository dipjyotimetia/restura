// Capability rows: Server-Sent Events.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const SSE_CAPABILITIES = {
  'sse.basic': { label: 'Server-Sent Events', web: true, desktop: true },
  'sse.customHeaders': {
    label: 'SSE with custom headers',
    web: true,
    desktop: true,
    notes:
      'Web streams via the Worker /api/proxy (fetch-based, not EventSource), so custom headers are forwarded',
  },
  'sse.autoReconnect': {
    label: 'SSE automatic reconnect (retry + Last-Event-ID)',
    web: true,
    desktop: true,
    notes:
      'WHATWG §9.2.3 reestablish with the server retry and Last-Event-ID; not after non-2xx, 204 or a non-event-stream Content-Type. The CLI captures a fixed window and does not reconnect',
  },
} as const satisfies Record<string, CapabilityRow>;
