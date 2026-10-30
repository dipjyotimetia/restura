import { vi } from 'vitest';

/**
 * In-memory stand-in for `window.electron.secrets` (the main-process secret
 * handle store) for renderer tests of broker credential handles (SEC-K3).
 * `records` is the "main side": tests assert on it to prove a value was stored
 * or copied without the renderer reading it back.
 */
export function createFakeSecretsApi() {
  const records = new Map<string, { value: string; label?: string; scope?: string }>();
  const api = {
    store: vi.fn(async (args: { id?: string; value: string; label?: string; scope?: string }) => {
      const id = args.id ?? `h-${records.size + 1}`;
      records.set(id, {
        value: args.value,
        ...(args.label ? { label: args.label } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
      });
      return { ok: true as const, id };
    }),
    delete: vi.fn(async (id: string) => {
      records.delete(id);
      return { ok: true as const };
    }),
    describe: vi.fn(async (id: string) => {
      const record = records.get(id);
      return {
        ok: true as const,
        handle: record
          ? {
              createdAt: 0,
              ...(record.label ? { label: record.label } : {}),
              ...(record.scope ? { scope: record.scope } : {}),
            }
          : null,
      };
    }),
    copy: vi.fn(async (args: { from: string; to: string; label?: string }) => {
      const source = records.get(args.from);
      if (!source) return { ok: true as const, copied: false };
      records.set(args.to, { ...source, ...(args.label ? { label: args.label } : {}) });
      return { ok: true as const, copied: true };
    }),
    list: vi.fn(async () => ({ ok: true as const, handles: [] })),
    clear: vi.fn(async () => {
      records.clear();
      return { ok: true as const };
    }),
  };
  return { api, records };
}

/** In-memory stand-in for `window.electron.store` (the encrypted electron-store). */
export function createFakeElectronStore() {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => void values.set(key, value)),
      delete: vi.fn(async (key: string) => void values.delete(key)),
      clear: vi.fn(async () => values.clear()),
    },
  };
}
