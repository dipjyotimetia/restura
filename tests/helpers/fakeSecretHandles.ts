/**
 * In-memory stand-in for `window.electron.secrets` (the main-process secret
 * handle store, ADR-0007) for renderer tests of broker credentials.
 * `valueFor(storageKey)` reads what main would resolve for a broker secret.
 */
import { vi } from 'vitest';
import { brokerSecretHandleId } from '@/lib/shared/broker-secrets';

export interface FakeSecretHandles {
  handles: Map<string, string>;
  /** Plaintext main holds for a broker secret storage key. */
  valueFor: (storageKey: string) => string | undefined;
  /** Seed a broker secret as if it had been stored earlier. */
  seed: (storageKey: string, value: string) => void;
  api: {
    store: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    describe: ReturnType<typeof vi.fn>;
    copy: ReturnType<typeof vi.fn>;
  };
  uninstall: () => void;
}

export function installFakeSecretHandles(): FakeSecretHandles {
  const handles = new Map<string, string>();
  const api = {
    store: vi.fn(async ({ id, value }: { id?: string; value: string }) => {
      const handleId = id ?? crypto.randomUUID();
      handles.set(handleId, value);
      return { ok: true as const, id: handleId };
    }),
    delete: vi.fn(async (id: string) => {
      handles.delete(id);
      return { ok: true as const };
    }),
    describe: vi.fn(async (id: string) => ({
      ok: true as const,
      handle: handles.has(id) ? { id, createdAt: 0 } : null,
    })),
    copy: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const value = handles.get(from);
      if (value === undefined) return { ok: true as const, copied: false };
      handles.set(to, value);
      return { ok: true as const, copied: true };
    }),
  };
  const w = window as unknown as { electron?: Record<string, unknown> };
  const previous = w.electron;
  w.electron = { ...(previous ?? {}), secrets: api };
  return {
    handles,
    api,
    valueFor: (key) => handles.get(brokerSecretHandleId(key)),
    seed: (key, value) => {
      handles.set(brokerSecretHandleId(key), value);
    },
    uninstall: () => {
      w.electron = previous;
    },
  };
}
