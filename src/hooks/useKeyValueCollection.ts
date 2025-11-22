import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { KeyValue } from '@/types';

/**
 * Creates a new key-value item with default values
 */
export function createKeyValueItem(overrides?: Partial<KeyValue>): KeyValue {
  return {
    id: uuidv4(),
    key: '',
    value: '',
    enabled: true,
    ...overrides,
  };
}

/**
 * Hook for managing key-value collections (params, headers, metadata)
 * Extracts common add/update/delete patterns used across RequestBuilder and GrpcRequestBuilder
 */
export function useKeyValueCollection(
  items: KeyValue[],
  onUpdate: (items: KeyValue[]) => void
) {
  const handleAdd = useCallback(() => {
    onUpdate([...items, createKeyValueItem()]);
  }, [items, onUpdate]);

  const handleUpdate = useCallback(
    (id: string, updates: Partial<KeyValue>) => {
      onUpdate(items.map((item) => (item.id === id ? { ...item, ...updates } : item)));
    },
    [items, onUpdate]
  );

  const handleDelete = useCallback(
    (id: string) => {
      onUpdate(items.filter((item) => item.id !== id));
    },
    [items, onUpdate]
  );

  return {
    handleAdd,
    handleUpdate,
    handleDelete,
  };
}
