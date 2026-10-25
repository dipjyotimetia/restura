// Capability rows: Collections, workflows, the local mock server and browser capture.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const WORKSPACE_CAPABILITIES = {
  'collections.file': { label: 'Filesystem-backed collections', web: false, desktop: true },
  'collections.git': {
    label: 'Git operations on collections',
    web: false,
    desktop: true,
    notes:
      'System-Git status, diff, staging, commits, branches, fetch/pull/push, and explicit resumable merges for registered OpenCollection directories; structured YAML conflict resolution validates before staging',
  },
  'collections.brokerPresets': {
    label: 'Kafka / MQTT connection presets in collections',
    web: false,
    desktop: true,
    notes:
      'Save a Kafka or MQTT tab to a collection and reopen it prefilled; {{var}} resolved at send time. Presets round-trip through OpenCollection (x-restura-kafka / x-restura-mqtt) and git-native collections; credentials stay in the desktop secure store and are never exported. Web lists imported presets but opens the desktop-only panel; the CLI skips them',
  },
  'workflows.ows': {
    label: 'Workflows',
    web: true,
    desktop: true,
    notes:
      'Safe sequential, guarded, loop, and recovery controls execute with typed data/output, timeout/cancellation, and binding-only HTTP or GraphQL saved-request calls. GraphQL mutations require explicit approval. Other controls, event/process tasks, inline transport configuration, and unsupported transports are rejected before persistence or execution.',
  },
  'mock.localServer': {
    label: 'Local mock server',
    web: false,
    desktop: true,
    notes: 'Binds a localhost HTTP listener; no browser TCP',
  },
  'capture.desktopBridge': {
    label: 'Browser capture desktop bridge',
    web: false,
    desktop: true,
    notes: 'Loopback receiver for the Restura capture extension; no browser TCP listener',
  },
} as const satisfies Record<string, CapabilityRow>;
