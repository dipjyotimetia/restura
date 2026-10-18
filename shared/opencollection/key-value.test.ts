import { describe, expect, it } from 'vitest';
import { kvFromInternal, kvToInternal } from './key-value';

describe('OpenCollection key-value rows', () => {
  it('round-trips enabled, disabled and described rows', () => {
    const row = { id: 'x', key: 'a', value: '1', enabled: false, description: 'd' };
    expect(kvFromInternal(row)).toEqual({
      name: 'a',
      value: '1',
      enabled: false,
      description: 'd',
    });
    expect(kvToInternal(kvFromInternal(row))).toMatchObject({
      key: 'a',
      value: '1',
      enabled: false,
      description: 'd',
    });
    expect(kvFromInternal({ id: 'y', key: 'b', value: '2', enabled: true })).toEqual({
      name: 'b',
      value: '2',
    });
  });

  it('tolerates the legacy `key` spelling and missing fields', () => {
    expect(kvToInternal({ key: 'legacy', enabled: 'yes' })).toMatchObject({
      key: 'legacy',
      value: '',
      enabled: true,
    });
    expect(kvToInternal(null)).toMatchObject({ key: '', value: '', enabled: true });
  });
});
