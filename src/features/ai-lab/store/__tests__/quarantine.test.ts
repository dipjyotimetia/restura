import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ rows: new Map<string, unknown>(), writes: 0, failWrites: false }));
const toastWarning = vi.hoisted(() => vi.fn());
const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock('@/lib/shared/file-utils', () => ({ downloadBlob }));
vi.mock('@/lib/shared/dexie-storage', () => ({
  setDexieStorageItemStrict: async (table: string, name: string, value: unknown) => {
    if (mem.failWrites) throw new Error('quota');
    mem.writes += 1;
    mem.rows.set(`${table}/${name}`, value);
  },
  getDexieStorageItemStrict: async (table: string, name: string) =>
    mem.rows.get(`${table}/${name}`) ?? null,
}));
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }));

import { hasQuarantinedData, partitionRecords, quarantineInvalid } from '../quarantine';

describe('quarantineInvalid', () => {
  beforeEach(() => {
    mem.rows.clear();
    mem.writes = 0;
    mem.failWrites = false;
    toastWarning.mockReset();
    downloadBlob.mockReset();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('writes one backup row per distinct content, not one per launch', async () => {
    const blob = { providers: { p1: { broken: true } } };
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', blob);
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', {
      providers: { p1: { broken: true } },
    });
    expect(mem.rows.size).toBe(1);
    expect(mem.writes).toBe(1);
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', { providers: { p2: 1 } });
    expect(mem.rows.size).toBe(2);
  });

  it('says so when the backup could not be saved, and exports the blob on request', async () => {
    mem.failWrites = true;
    const blob = { providers: { p1: 1, p2: 2 } };
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', blob);
    vi.advanceTimersByTime(2_000);
    const [title, options] = toastWarning.mock.calls[0] as [
      string,
      { description: string; action: { onClick: () => void } },
    ];
    expect(title).toBe('2 invalid AI Lab records were removed');
    expect(options.description).toMatch(/could not be saved/);
    options.action.onClick();
    expect(downloadBlob).toHaveBeenCalledWith(
      JSON.stringify(blob, null, 2),
      'restura-ai-lab-ai-lab-store-invalid.json'
    );
  });

  it('does nothing for an empty blob', async () => {
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', { providers: {} });
    expect(mem.rows.size).toBe(0);
  });

  it('describes the backup without promising an in-app restore', async () => {
    await quarantineInvalid('aiLab', 'ai-lab-store', 'AI Lab', { providers: { p1: 1 } });
    vi.advanceTimersByTime(2_000);
    const [title, options] = toastWarning.mock.calls[0] as [string, { description: string }];
    expect(title).toBe('1 invalid AI Lab record was removed');
    expect(options.description).toMatch(/Export backup/);
    expect(options.description).not.toMatch(/recover the data/);
  });
});

describe('partitionRecords', () => {
  it('flags a malformed container', () => {
    const schema = { safeParse: () => ({ success: true }) } as never;
    expect(partitionRecords([1], schema).invalid).toEqual({ '(root)': [1] });
    expect(hasQuarantinedData({ a: {} })).toBe(false);
  });
});
