/**
 * Capability matrix (Gap #10). Single source of truth for which features
 * work on which target. Read by:
 *
 *   - the `<CapabilityBadge>` component (renders "Desktop only" tags)
 *   - the doc generator at `scripts/generate-capability-matrix.mjs` (writes
 *     `docs/CAPABILITY_MATRIX.md`; CI checks for drift)
 *
 * Rows live in per-area modules under `./capabilities/` so concurrent feature
 * PRs don't collide in one record. To add a capability, append a row to the
 * matching area module — `CapabilityName` is derived from the composed keys.
 * The spread order below (then row order inside each module) is the row order
 * of the generated matrix (the generator bundles this file with esbuild and
 * reads the composed object, so it must stay import-free of browser/DOM code).
 *
 * Keep keys stable — they're referenced by `<CapabilityBadge feature="...">`.
 */

import { AI_CAPABILITIES } from './capabilities/ai';
import { AI_LAB_CAPABILITIES } from './capabilities/ai-lab';
import { GRPC_CAPABILITIES } from './capabilities/grpc';
import { HTTP_CAPABILITIES } from './capabilities/http';
import { KAFKA_CAPABILITIES } from './capabilities/kafka';
import { LOAD_TESTING_CAPABILITIES } from './capabilities/load-testing';
import { MCP_CAPABILITIES } from './capabilities/mcp';
import { MQTT_CAPABILITIES } from './capabilities/mqtt';
import { PLATFORM_CAPABILITIES } from './capabilities/platform';
import { SCRIPTS_CAPABILITIES } from './capabilities/scripts';
import { SOCKETIO_CAPABILITIES } from './capabilities/socketio';
import { SSE_CAPABILITIES } from './capabilities/sse';
import type { CapabilityRow } from './capabilities/types';
import { WEBSOCKET_CAPABILITIES } from './capabilities/websocket';
import { WORKSPACE_CAPABILITIES } from './capabilities/workspace';

export type { CapabilityRow } from './capabilities/types';

const ALL_CAPABILITIES = {
  ...HTTP_CAPABILITIES,
  ...LOAD_TESTING_CAPABILITIES,
  ...WEBSOCKET_CAPABILITIES,
  ...SSE_CAPABILITIES,
  ...MCP_CAPABILITIES,
  ...GRPC_CAPABILITIES,
  ...KAFKA_CAPABILITIES,
  ...MQTT_CAPABILITIES,
  ...SOCKETIO_CAPABILITIES,
  ...AI_CAPABILITIES,
  ...AI_LAB_CAPABILITIES,
  ...WORKSPACE_CAPABILITIES,
  ...PLATFORM_CAPABILITIES,
  ...SCRIPTS_CAPABILITIES,
};

export type CapabilityName = keyof typeof ALL_CAPABILITIES;

export const CAPABILITIES: Record<CapabilityName, CapabilityRow> = ALL_CAPABILITIES;

export function isCapableHere(name: CapabilityName, isElectron: boolean): boolean {
  const row = CAPABILITIES[name];
  return isElectron ? row.desktop : row.web;
}
