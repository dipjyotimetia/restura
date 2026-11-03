import { afterEach, describe, expect, it, vi } from 'vitest';

/** `colors.ts` reads the terminal once at import, so each case re-imports it. */
async function load(isTTY: boolean, env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  try {
    return await import('../colors');
  } finally {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('terminal capability gating', () => {
  it('NO_COLOR turns colour off but keeps a TTY interactive (wizard, dashboard)', async () => {
    const colors = await load(true, { NO_COLOR: '1', FORCE_COLOR: undefined });
    expect(colors.colorEnabled).toBe(false);
    expect(colors.interactive).toBe(true);
    expect(colors.color.red('x')).toBe('x');
  });

  it('FORCE_COLOR colours piped output but never makes it interactive', async () => {
    const colors = await load(false, { NO_COLOR: undefined, FORCE_COLOR: '1' });
    expect(colors.colorEnabled).toBe(true);
    expect(colors.interactive).toBe(false);
  });

  it('a plain TTY is coloured and interactive; a pipe is neither', async () => {
    const tty = await load(true, { NO_COLOR: undefined, FORCE_COLOR: undefined });
    expect([tty.colorEnabled, tty.interactive]).toEqual([true, true]);
    const pipe = await load(false, { NO_COLOR: undefined, FORCE_COLOR: undefined });
    expect([pipe.colorEnabled, pipe.interactive]).toEqual([false, false]);
  });
});
