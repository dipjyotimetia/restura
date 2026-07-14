import { describe, expect, it } from 'vitest';
import type { Collection, Environment } from '@/types';
import { buildBaseVars } from '../useCollectionRun';

describe('buildBaseVars', () => {
  it('layers globals, enabled environment values, then collection values', () => {
    const environment: Environment = {
      id: 'env',
      name: 'Environment',
      variables: [
        { id: 'e1', key: 'shared', value: 'environment', enabled: true },
        { id: 'e2', key: 'environmentOnly', value: 'yes', enabled: true },
        { id: 'e3', key: 'disabled', value: 'hidden', enabled: false },
      ],
    };
    const collection: Collection = {
      id: 'collection',
      name: 'Collection',
      items: [],
      variables: [
        { id: 'c1', key: 'shared', value: 'collection', enabled: true },
        { id: 'c2', key: 'collectionOnly', value: 'yes', enabled: true },
      ],
    };

    expect(buildBaseVars({ shared: 'global', globalOnly: 'yes' }, environment, collection)).toEqual(
      {
        shared: 'collection',
        globalOnly: 'yes',
        environmentOnly: 'yes',
        collectionOnly: 'yes',
      }
    );
  });
});
