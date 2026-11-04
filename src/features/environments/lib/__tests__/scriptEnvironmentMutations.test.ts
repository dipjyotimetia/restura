import { beforeEach, describe, expect, it } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Environment } from '@/types';
import {
  applyEnvironmentMutations,
  persistScriptEnvironmentMutations,
  scriptEnvironmentTargetId,
} from '../scriptEnvironmentMutations';

function env(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env-1',
    name: 'Dev',
    variables: [
      { id: 'v1', key: 'token', value: 'old', enabled: true },
      { id: 'v2', key: 'stale', value: 's', enabled: true },
      {
        id: 'v3',
        key: 'apiKey',
        value: '',
        enabled: true,
        secret: true,
        secretRef: { kind: 'keychain', id: 'k1' } as never,
      },
      { id: 'v4', key: 'masked', value: 'm', enabled: true, secret: true },
    ],
    ...overrides,
  };
}

describe('applyEnvironmentMutations', () => {
  it('updates, adds and removes plain variables', () => {
    const outcome = applyEnvironmentMutations(
      env(),
      { token: 'new', user_id: 'u-1', stale: null, masked: 'm2' },
      () => 'new-id'
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.environment.variables.map((v) => [v.key, v.value])).toEqual([
      ['token', 'new'],
      ['apiKey', ''],
      ['masked', 'm2'],
      ['user_id', 'u-1'],
    ]);
    // A secret-flagged plain variable keeps its flag.
    expect(outcome.environment.variables.find((v) => v.key === 'masked')?.secret).toBe(true);
  });

  it('never overwrites or removes a secret handle', () => {
    const before = env();
    const outcome = applyEnvironmentMutations(before, { apiKey: 'plaintext' });
    expect(outcome.skipped).toEqual(['apiKey']);
    expect(outcome.changed).toBe(false);
    expect(outcome.environment).toBe(before);
    expect(applyEnvironmentMutations(before, { apiKey: null }).skipped).toEqual(['apiKey']);
  });

  it('is a no-op when nothing changes', () => {
    const before = env();
    const outcome = applyEnvironmentMutations(before, { token: 'old', missing: null });
    expect(outcome.changed).toBe(false);
    expect(outcome.environment).toBe(before);
  });
});

describe('persistScriptEnvironmentMutations', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [env()], activeEnvironmentId: 'env-1' });
  });

  it('writes to the stored environment', () => {
    expect(persistScriptEnvironmentMutations('env-1', { user_id: 'u-9' })).toEqual([]);
    const stored = useEnvironmentStore.getState().environments[0];
    expect(stored?.variables.find((v) => v.key === 'user_id')?.value).toBe('u-9');
  });

  it('targets the active environment only when it applies to the request', () => {
    expect(scriptEnvironmentTargetId(undefined)).toBe('env-1');
    useEnvironmentStore.setState({
      environments: [env({ collectionId: 'c-1' })],
      activeEnvironmentId: 'env-1',
    });
    expect(scriptEnvironmentTargetId('c-1')).toBe('env-1');
    expect(scriptEnvironmentTargetId('c-2')).toBeUndefined();
    useEnvironmentStore.setState({ activeEnvironmentId: null });
    expect(scriptEnvironmentTargetId(undefined)).toBeUndefined();
  });
});
