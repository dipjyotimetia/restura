import { describe, expect, it } from 'vitest';
import { duplicateEnvironment } from '../environmentActions';
import type { Environment } from '@/types';

describe('duplicateEnvironment', () => {
  it('creates independently addressable environment and variable records', () => {
    const source = {
      id: 'environment-1',
      name: 'Staging',
      variables: [
        { id: 'variable-1', key: 'baseUrl', value: 'https://staging.example.com', enabled: true },
      ],
    } as Environment;
    const ids = ['environment-2', 'variable-2'];

    const duplicate = duplicateEnvironment(source, () => ids.shift()!);

    expect(duplicate).toMatchObject({
      id: 'environment-2',
      name: 'Staging (copy)',
      variables: [{ id: 'variable-2', key: 'baseUrl' }],
    });
    expect(duplicate.variables[0]).not.toBe(source.variables[0]);
  });
});
