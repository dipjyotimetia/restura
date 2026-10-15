import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcSchemaSnapshot, ReflectionServiceInfo } from '@/types';

const store = vi.hoisted(() => ({
  activeTabId: 'tab-a' as string | null,
  updateRequest: vi.fn(),
}));

vi.mock('@/features/grpc/lib/grpcSchemaSnapshot', () => ({
  reflectionSnapshotDecision: vi.fn((service: { name: string }) => ({
    action: 'drift',
    snapshot: { kind: 'descriptors', descriptors: [service.name] },
    diff: { changes: [], breaking: 1, nonBreaking: 0 },
  })),
  stampSnapshot: vi.fn((s: unknown) => s),
}));

vi.mock('@/store/selectors', () => ({
  useActiveTab: () => (store.activeTabId ? { id: store.activeTabId } : undefined),
}));

vi.mock('@/store/useRequestStore', () => {
  const getState = () => ({
    activeTabId: store.activeTabId,
    tabs: ['tab-a', 'tab-b'].map((id) => ({
      id,
      request: { type: 'grpc', schema: undefined },
    })),
    updateRequest: store.updateRequest,
  });
  const useRequestStore = (selector: (s: ReturnType<typeof getState>) => unknown) =>
    selector(getState());
  useRequestStore.getState = getState;
  return { useRequestStore };
});

import { useGrpcSchemaDrift } from '../useGrpcSchemaDrift';

const service = (name: string) => ({ name }) as unknown as ReflectionServiceInfo;
const upload: GrpcSchemaSnapshot = { kind: 'proto', fileName: 'a.proto', text: '' };

describe('useGrpcSchemaDrift — per-tab pending drift', () => {
  beforeEach(() => {
    store.activeTabId = 'tab-a';
    store.updateRequest.mockClear();
  });

  it('keeps drift raised on one tab when another tab reflects or uploads', () => {
    const { result, rerender } = renderHook(() => useGrpcSchemaDrift());
    act(() => result.current.onServiceReflected(service('A')));
    expect(result.current.drift?.next).toEqual({ kind: 'descriptors', descriptors: ['A'] });

    store.activeTabId = 'tab-b';
    rerender();
    expect(result.current.drift).toBeNull();
    act(() => result.current.onServiceReflected(service('B')));
    expect(result.current.drift?.next).toEqual({ kind: 'descriptors', descriptors: ['B'] });
    act(() => result.current.saveUpload(upload));
    expect(result.current.drift).toBeNull();

    store.activeTabId = 'tab-a';
    rerender();
    expect(result.current.drift?.next).toEqual({ kind: 'descriptors', descriptors: ['A'] });
  });

  it('accept/dismiss clear only the active tab', () => {
    const { result, rerender } = renderHook(() => useGrpcSchemaDrift());
    act(() => result.current.onServiceReflected(service('A')));
    store.activeTabId = 'tab-b';
    rerender();
    act(() => result.current.onServiceReflected(service('B')));
    act(() => result.current.accept());
    expect(store.updateRequest).toHaveBeenLastCalledWith({
      schema: { kind: 'descriptors', descriptors: ['B'] },
    });
    expect(result.current.drift).toBeNull();

    store.activeTabId = 'tab-a';
    rerender();
    expect(result.current.drift).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.drift).toBeNull();
    // Dismissing with nothing pending is a no-op.
    act(() => result.current.dismiss());
    expect(result.current.drift).toBeNull();
  });

  it('shows nothing without an active tab', () => {
    store.activeTabId = null;
    const { result } = renderHook(() => useGrpcSchemaDrift());
    act(() => result.current.saveUpload(upload));
    expect(result.current.drift).toBeNull();
  });
});
