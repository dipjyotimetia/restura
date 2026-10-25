// Capability rows: Load / performance testing.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const LOAD_TESTING_CAPABILITIES = {
  'loadTesting.basic': {
    label: 'Load / performance testing',
    web: true,
    desktop: true,
    notes:
      'Fidelity differs: web is capped by ~6 browser connections per origin and the Worker proxy rate limit (100 req/min); desktop by the IPC rate budget. Results above those budgets include self-inflicted throttling',
  },
} as const satisfies Record<string, CapabilityRow>;
