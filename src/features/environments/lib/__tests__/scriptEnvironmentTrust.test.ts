import { beforeEach, describe, expect, it, vi } from 'vitest';

type ToastOptions = {
  action?: { onClick: () => void };
  cancel?: { onClick: () => void };
};
const toastWarning = vi.hoisted(() => vi.fn<(message: string, options?: ToastOptions) => void>());
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }));

import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  resetScriptEnvironmentApprovals,
  saveScriptEnvironmentWrites,
} from '../scriptEnvironmentMutations';

const values = (id: string) =>
  Object.fromEntries(
    (useEnvironmentStore.getState().environments.find((e) => e.id === id)?.variables ?? []).map(
      (v) => [v.key, v.value]
    )
  );

beforeEach(() => {
  resetScriptEnvironmentApprovals();
  toastWarning.mockReset();
  useEnvironmentStore.setState({
    environments: [
      {
        id: 'shared',
        name: 'Shared',
        variables: [{ id: 'v1', key: 'apiBase', value: 'https://api.mine', enabled: true }],
      },
      { id: 'scoped', name: 'Scoped', collectionId: 'col-a', variables: [] },
    ],
    activeEnvironmentId: 'shared',
  } as never);
});

describe('script environment writes: trust', () => {
  it('saves a collection script write to an environment scoped to that collection', () => {
    saveScriptEnvironmentWrites({
      environmentId: 'scoped',
      collectionId: 'col-a',
      mutations: { token: 't' },
    });
    expect(values('scoped')).toEqual({ token: 't' });
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('saves a write from a request that is in no collection (the user wrote the script)', () => {
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: undefined,
      mutations: { token: 't' },
    });
    expect(values('shared')).toMatchObject({ token: 't' });
  });

  it('never lets a collection script overwrite a shared environment without asking', () => {
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: 'imported',
      mutations: { apiBase: 'https://attacker.example' },
    });
    expect(values('shared')).toEqual({ apiBase: 'https://api.mine' });
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it('saves the held writes once the user approves, and later writes without asking again', () => {
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: 'col-a',
      mutations: { token: 't-1' },
    });
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: 'col-a',
      mutations: { user: 'u' },
    });
    toastWarning.mock.calls.at(-1)?.[1]?.action?.onClick();
    expect(values('shared')).toMatchObject({ token: 't-1', user: 'u' });

    toastWarning.mockClear();
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: 'col-a',
      mutations: { token: 't-2' },
    });
    expect(values('shared')).toMatchObject({ token: 't-2' });
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('drops the held writes when the user declines', () => {
    saveScriptEnvironmentWrites({
      environmentId: 'shared',
      collectionId: 'col-a',
      mutations: { apiBase: 'https://x' },
    });
    toastWarning.mock.calls[0]?.[1]?.cancel?.onClick();
    expect(values('shared')).toEqual({ apiBase: 'https://api.mine' });
  });
});
