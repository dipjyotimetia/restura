import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';

/**
 * Push the Settings → Security outbound-network policy to the Electron main
 * process so every SSRF guard (HTTP, WebSocket, SSE, Socket.IO, gRPC, MCP)
 * shares one policy. Mirrors the telemetry-consent sync (electron-sentry.ts):
 * push once at startup, then forward every change.
 *
 * The store rehydrates from Dexie asynchronously, so the initial push may carry
 * the defaults (localhost allowed, private blocked); the subscription catches
 * the rehydrated value if it differs. Main defaults to the same safe baseline,
 * so any brief pre-push window fails closed for the private-IP opt-in.
 */

let subscribed = false;

interface NetworkPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
}

function readPolicy(): NetworkPolicy {
  const s = useSettingsStore.getState().settings;
  return { allowLocalhost: s.allowLocalhost ?? true, allowPrivateIPs: s.allowPrivateIPs === true };
}

function pushPolicy(policy: NetworkPolicy): void {
  // Best-effort; a failed push must never break the app (main keeps its last value).
  void window.electron?.security?.setNetworkPolicy(policy);
}

export function initNetworkPolicySync(): void {
  if (!isElectron() || subscribed) return;
  subscribed = true;
  let last = readPolicy();
  pushPolicy(last);
  useSettingsStore.subscribe((state) => {
    const next: NetworkPolicy = {
      allowLocalhost: state.settings.allowLocalhost ?? true,
      allowPrivateIPs: state.settings.allowPrivateIPs === true,
    };
    if (
      next.allowLocalhost !== last.allowLocalhost ||
      next.allowPrivateIPs !== last.allowPrivateIPs
    ) {
      last = next;
      pushPolicy(next);
    }
  });
}
