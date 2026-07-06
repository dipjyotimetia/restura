import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createValidatedHandler } from '../ipc/ipc-validators';

/**
 * Outbound-network policy (Settings → Security) as a main-process snapshot.
 *
 * The canonical values live in the renderer settings store; the renderer pushes
 * them here over `security:setNetworkPolicy` on startup and on every change
 * (src/lib/electron-network-policy.ts), mirroring the telemetry-consent pattern.
 * Every guarded outbound transport — HTTP, WebSocket, SSE, Socket.IO, gRPC, MCP
 * — reads this single snapshot, so one policy governs all of them instead of
 * each handler hardcoding its own `allowLocalhost: true`.
 *
 * Kafka and MQTT are intentionally NOT governed here: their broker guards
 * (kafka-broker-guard.ts / mqtt-broker-guard.ts) always permit private/LAN
 * broker addresses because that is the protocol's primary use case (cloud
 * metadata stays blocked). The Settings → Security copy discloses this.
 *
 * Defaults are the safe baseline applied before the first push (and if the
 * renderer never pushes): localhost permitted, private/RFC-1918 blocked.
 * Cloud-metadata endpoints stay blocked in the shared URL guard regardless of
 * this policy.
 */
export interface NetworkPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
}

let policy: NetworkPolicy = { allowLocalhost: true, allowPrivateIPs: false };

export function getNetworkPolicy(): NetworkPolicy {
  return policy;
}

export function setNetworkPolicy(next: NetworkPolicy): void {
  policy = { allowLocalhost: next.allowLocalhost, allowPrivateIPs: next.allowPrivateIPs };
}

const NetworkPolicySchema = z.object({
  allowLocalhost: z.boolean(),
  allowPrivateIPs: z.boolean(),
});

export function registerNetworkPolicyIPC(): void {
  ipcMain.handle(
    IPC.security.setNetworkPolicy,
    createValidatedHandler(
      IPC.security.setNetworkPolicy,
      NetworkPolicySchema,
      (
        next
      ): {
        ok: true;
      } => {
        setNetworkPolicy(next);
        return { ok: true };
      }
    )
  );
}
