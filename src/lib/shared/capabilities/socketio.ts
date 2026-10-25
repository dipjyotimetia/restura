// Capability rows: Socket.IO.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const SOCKETIO_CAPABILITIES = {
  'socketio.basic': { label: 'Socket.IO client', web: true, desktop: true },
} as const satisfies Record<string, CapabilityRow>;
