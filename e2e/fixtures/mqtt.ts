import { test as base, expect, type Page } from '@playwright/test';

/**
 * E2E fixture for the desktop-only MQTT client.
 *
 * MQTT runs over the Electron IPC bridge (`window.electron.mqtt`), but the
 * Playwright harness runs the WEB build (Vite dev server) where `window.electron`
 * is absent. To exercise the real renderer flow (MqttClient → mqttManager →
 * useMqttStore → console) end-to-end without Electron or a live broker, we inject
 * a stateful **loopback-broker** mock of `window.electron` before the app loads:
 *
 *   - `isElectron()` returns true, so the full client UI renders (not the
 *     desktop-only panel) and the MQTT entry point appears in the menus.
 *   - `mqtt.connect` emits a CONNACK; `mqtt.subscribe` records the filter and
 *     acks it; `mqtt.publish` echoes the message back on any matching
 *     subscription (so a publish round-trips into the message log).
 *   - Every OTHER `window.electron` namespace the desktop build activates
 *     (keychain banner, auto-updater, secure-storage) is stubbed: the few that
 *     need a real shape are provided explicitly, the rest resolve to a no-op via
 *     a Proxy so an unanticipated call can't crash app bootstrap.
 *
 * The full TCP/TLS path (real `mqtt.connect` against a broker) is Electron-only
 * and would need Playwright's `_electron` launcher; it's covered at the unit
 * layer (electron/main/handlers/mqtt-handler, mqttManager.electron.test). This fixture
 * covers the renderer + DOM that unit tests can't.
 */

const ONBOARDING_KEY = 'restura-onboarding-completed';

function installMqttElectronBridge(): void {
  // NOTE: runs in the browser via addInitScript — fully self-contained, no
  // imports or outer-scope references allowed.
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const subs = new Map<string, Map<string, number>>();

  const emit = (channel: string, payload?: unknown): void => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        /* ignore listener errors */
      }
    }
  };

  // MQTT topic-filter match: `+` = one level, `#` = rest (final level only).
  const topicMatches = (filter: string, topic: string): boolean => {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i += 1) {
      if (f[i] === '#') return true;
      if (f[i] === '+') {
        if (t[i] === undefined) return false;
        continue;
      }
      if (f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  };

  const ensureSubs = (id: string): Map<string, number> => {
    let m = subs.get(id);
    if (!m) {
      m = new Map();
      subs.set(id, m);
    }
    return m;
  };

  type ConnectCfg = { connectionId: string };
  type SubCfg = { connectionId: string; topicFilter: string; qos: number };
  type PubCfg = {
    connectionId: string;
    topic: string;
    payload: string;
    qos: number;
    retain: boolean;
  };

  const mqtt = {
    connect: async (cfg: ConnectCfg) => {
      ensureSubs(cfg.connectionId);
      // CONNACK arrives asynchronously, like a real broker handshake.
      setTimeout(
        () =>
          emit(`mqtt:connected:${cfg.connectionId}`, {
            timestamp: Date.now(),
            sessionPresent: false,
          }),
        20
      );
      return { success: true };
    },
    subscribe: async (cfg: SubCfg) => {
      ensureSubs(cfg.connectionId).set(cfg.topicFilter, cfg.qos);
      emit(`mqtt:subscribed:${cfg.connectionId}`, {
        topicFilter: cfg.topicFilter,
        grantedQos: cfg.qos,
      });
      return { success: true };
    },
    unsubscribe: async (cfg: { connectionId: string; topicFilter: string }) => {
      subs.get(cfg.connectionId)?.delete(cfg.topicFilter);
      emit(`mqtt:unsubscribed:${cfg.connectionId}`, { topicFilter: cfg.topicFilter });
      return { success: true };
    },
    publish: async (cfg: PubCfg) => {
      const m = subs.get(cfg.connectionId);
      if (m) {
        for (const filter of m.keys()) {
          if (topicMatches(filter, cfg.topic)) {
            emit(`mqtt:message:${cfg.connectionId}`, {
              topic: cfg.topic,
              payload: cfg.payload,
              qos: cfg.qos,
              retain: cfg.retain,
              dup: false,
              timestamp: Date.now(),
            });
            break;
          }
        }
      }
      return { success: true, ack: { topic: cfg.topic, qos: cfg.qos, timestamp: Date.now() } };
    },
    disconnect: async (cfg: ConnectCfg) => {
      subs.delete(cfg.connectionId);
      emit(`mqtt:close:${cfg.connectionId}`, {});
      return { success: true };
    },
    on: (channel: string, cb: (payload?: unknown) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
    },
    removeListener: (channel: string, cb: (payload?: unknown) => void) => {
      listeners.get(channel)?.delete(cb);
    },
    removeAllListeners: (channel: string) => {
      listeners.delete(channel);
    },
  };

  const keychainStatus = {
    mode: 'safeStorage' as const,
    plaintextStores: [],
    lastChecked: new Date().toISOString(),
  };

  const overrides: Record<string, unknown> = {
    isElectron: true,
    platform: 'darwin',
    mqtt,
    keychain: {
      status: async () => keychainStatus,
      rotate: async () => ({ rotated: false, status: keychainStatus }),
    },
    updater: {
      onStatus: () => () => {},
      getStatus: async () => ({ state: 'idle' as const }),
      check: async () => ({ updateAvailable: false }),
      setConfig: async () => {},
      download: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      restart: async () => {},
    },
    app: {
      getVersion: async () => '0.0.0-e2e',
      getPath: async () => '/tmp',
      checkForUpdates: async () => ({ updateAvailable: false }),
    },
    store: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      clear: async () => {},
      has: async () => false,
    },
    fs: {
      readFile: async () => ({ success: true, content: '' }),
      writeFile: async () => ({ success: true }),
    },
    on: () => {},
    removeListener: () => {},
  };

  // Any namespace the desktop build touches that we didn't model explicitly
  // resolves to a no-op async function, so bootstrap can't throw on a call we
  // didn't anticipate. `then` is guarded so the bridge is never mistaken for a
  // thenable (e.g. if something `await`s the object itself).
  const noopNamespace = new Proxy({}, { get: () => () => Promise.resolve(undefined) });
  (window as unknown as { electron: unknown }).electron = new Proxy(overrides, {
    get: (target, prop: string) => {
      if (prop === 'then') return undefined;
      return prop in target ? target[prop] : noopNamespace;
    },
  });
}

type MqttFixtures = { app: Page };

export const test = base.extend<MqttFixtures>({
  app: async ({ page }, use) => {
    await page.addInitScript((key: string) => {
      try {
        window.localStorage.setItem(key, 'true');
      } catch {
        /* localStorage may be unavailable before navigation */
      }
    }, ONBOARDING_KEY);
    await page.addInitScript(installMqttElectronBridge);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();
    await use(page);
  },
});

export { expect };

/** Open a fresh MQTT client tab from the new-request menu. */
export async function openMqttTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'new request', exact: true }).click();
  // The decorative <ProtoChip> prefixes the menuitem's accessible name
  // ("MQTT MQTT client"), so match the label as a substring, not exact.
  await page.getByRole('menuitem', { name: 'MQTT client' }).click();
}
