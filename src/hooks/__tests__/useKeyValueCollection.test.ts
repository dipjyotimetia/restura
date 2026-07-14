import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyValue } from '@/types';
import { createKeyValueItem, useKeyValueCollection } from '../useKeyValueCollection';

describe('createKeyValueItem', () => {
  it('creates an enabled item with a fresh id and empty key/value', () => {
    const item = createKeyValueItem();
    expect(item.id).toBeTruthy();
    expect(item).toMatchObject({ key: '', value: '', enabled: true });
  });

  it('applies overrides over the defaults', () => {
    const item = createKeyValueItem({ key: 'Content-Type', value: 'application/json' });
    expect(item).toMatchObject({ key: 'Content-Type', value: 'application/json', enabled: true });
  });
});

describe('useKeyValueCollection', () => {
  it('handleAdd appends a blank item when called with no args', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() => useKeyValueCollection([], onUpdate));

    act(() => result.current.handleAdd());

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const next = onUpdate.mock.calls[0]![0] as KeyValue[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ key: '', value: '', enabled: true });
  });

  it('handleAdd appends a pre-filled item when given overrides', () => {
    const onUpdate = vi.fn();
    const existing: KeyValue[] = [{ id: 'a', key: 'x', value: '1', enabled: true }];
    const { result } = renderHook(() => useKeyValueCollection(existing, onUpdate));

    act(() => result.current.handleAdd({ key: 'page', value: '2', description: 'pagination' }));

    const next = onUpdate.mock.calls[0]![0] as KeyValue[];
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(existing[0]); // preserves prior items
    expect(next[1]).toMatchObject({
      key: 'page',
      value: '2',
      description: 'pagination',
      enabled: true,
    });
    expect(next[1]!.id).toBeTruthy();
  });

  it('handleUpdate patches only the matching item', () => {
    const onUpdate = vi.fn();
    const existing: KeyValue[] = [
      { id: 'a', key: 'x', value: '1', enabled: true },
      { id: 'b', key: 'y', value: '2', enabled: true },
    ];
    const { result } = renderHook(() => useKeyValueCollection(existing, onUpdate));

    act(() => result.current.handleUpdate('b', { enabled: false }));

    const next = onUpdate.mock.calls[0]![0] as KeyValue[];
    expect(next[0]).toBe(existing[0]);
    expect(next[1]).toMatchObject({ id: 'b', enabled: false });
  });

  it('handleDelete removes the matching item', () => {
    const onUpdate = vi.fn();
    const existing: KeyValue[] = [
      { id: 'a', key: 'x', value: '1', enabled: true },
      { id: 'b', key: 'y', value: '2', enabled: true },
    ];
    const { result } = renderHook(() => useKeyValueCollection(existing, onUpdate));

    act(() => result.current.handleDelete('a'));

    const next = onUpdate.mock.calls[0]![0] as KeyValue[];
    expect(next).toEqual([existing[1]]);
  });
});
