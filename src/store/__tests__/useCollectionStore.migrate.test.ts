import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '../useCollectionStore';

type Migrate = (state: unknown, version: number) => { collections: unknown[] };

function migrate(): Migrate {
  const fn = useCollectionStore.persist.getOptions().migrate;
  if (!fn) throw new Error('no migrate');
  return fn as unknown as Migrate;
}

describe('useCollectionStore migrate (legacy auth, version < 3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps every collection when one legacy collection is malformed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = { id: 'good', name: 'Good', items: [] };
    const malformed = { id: 'bad', name: 'Bad', items: 'not-an-array' };
    const nullish = null;

    const result = migrate()(
      { collections: [good, malformed, nullish], activeCollectionId: 'good' },
      2
    );

    expect(result.collections).toHaveLength(3);
    expect(result.collections[1]).toBe(malformed);
    expect(result.collections[2]).toBeNull();
    expect((result.collections[0] as { id: string }).id).toBe('good');
  });
});
