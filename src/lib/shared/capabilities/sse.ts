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
} as const satisfies Record<string, CapabilityRow>;
