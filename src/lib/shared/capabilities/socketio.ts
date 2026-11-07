// Capability rows: Socket.IO.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const SOCKETIO_CAPABILITIES = {
  'socketio.basic': {
    label: 'Socket.IO client',
    web: true,
    desktop: true,
    notes:
      'Desktop refuses a redirected handshake or polling request and reports it; on web, the browser handles polling redirects. Every connect creates a fresh Manager (never multiplexed); the saved forceNew option has no effect',
  },
} as const satisfies Record<string, CapabilityRow>;
