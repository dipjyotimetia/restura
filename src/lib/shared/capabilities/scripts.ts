// Capability rows: Pre-request / test script sandbox (rs.*).
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const SCRIPTS_CAPABILITIES = {
  'scripts.basic': {
    label: 'Pre-request / test scripts (rs.* sandbox)',
    web: true,
    desktop: true,
  },
  'scripts.sendRequest': {
    label: 'rs.sendRequest sub-requests inside scripts',
    web: true,
    desktop: true,
    notes: 'Routes through the same SSRF-guarded proxy as a top-level send',
  },
  'scripts.cookies': {
    label: 'rs.cookies read/write against the cookie jar',
    web: true,
    desktop: true,
  },
  'scripts.setNextRequest': {
    label: 'rs.execution.setNextRequest / skipRequest runner flow control',
    notes: 'skipRequest in the app Collection run covers HTTP; gRPC and MCP items still send',
    web: true,
    desktop: true,
  },
  'scripts.visualizer': {
    label: 'rs.visualizer.set rendered in a sandboxed iframe tab',
    web: true,
    desktop: true,
  },
  'scripts.vault': {
    label: 'rs.vault encrypted key-value secret store',
    web: false,
    desktop: true,
    notes: 'Backed by OS keychain via electron safeStorage; no equivalent in browser',
  },
  'scripts.judge': {
    label: 'rs.judge LLM-as-judge semantic assertions',
    web: false,
    desktop: true,
    notes: 'Routes through the AI Lab complete IPC; no Worker /api/ai route yet',
  },
} as const satisfies Record<string, CapabilityRow>;
