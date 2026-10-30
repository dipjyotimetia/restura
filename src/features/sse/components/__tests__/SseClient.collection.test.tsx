import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, KeyValue, SseRequest } from '@/types';

const manager = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/features/sse/lib/sseManager', () => ({ sseManager: manager }));

// The real table/auth editors are covered by their own suites; here they just
// need to emit a value through the builder's onChange.
vi.mock('@/components/shared/KeyValueTable', () => ({
  KeyValueTable: ({
    itemLabel,
    items,
    onChange,
  }: {
    itemLabel: string;
    items: KeyValue[];
    onChange: (items: KeyValue[]) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange([
          ...items,
          { id: `${itemLabel}-1`, key: `x-${itemLabel}`, value: `{{${itemLabel}}}`, enabled: true },
        ])
      }
    >
      {`Add ${itemLabel} (${items.length})`}
    </button>
  ),
}));

vi.mock('@/features/auth/components/AuthConfig', () => ({
  default: ({ auth, onChange }: { auth: AuthConfig; onChange: (auth: AuthConfig) => void }) => (
    <button type="button" onClick={() => onChange({ type: 'bearer', bearer: { token: 'tok' } })}>
      {`Auth: ${auth.type}`}
    </button>
  ),
}));

vi.mock('@/components/shared/StreamSplit', () => ({
  StreamSplit: ({ config, log }: { config: React.ReactNode; log: React.ReactNode }) => (
    <div>
      {config}
      {log}
    </div>
  ),
}));

import { SaveToCollectionDialog } from '@/components/shared/SaveToCollectionDialog';
import SseClient from '@/features/sse/components/SseClient';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';

function savedRequest(): SseRequest {
  const item = useCollectionStore.getState().collections[0]?.items[0];
  if (!item || item.type !== 'request' || !item.request) throw new Error('nothing saved');
  return item.request as SseRequest;
}

describe('SseClient ↔ collections', () => {
  beforeEach(() => {
    manager.connect.mockReset();
    manager.disconnect.mockReset();
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useCollectionStore.setState({ collections: [] });
    useSseStore.setState({ connections: {}, summaries: {}, activeConnectionId: null });
  });

  it('Save to Collection stores the configured SSE request, not the tab defaults', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().createNewRequest('sse');
    render(<SseClient />);

    fireEvent.change(screen.getByRole('textbox', { name: 'SSE endpoint URL' }), {
      target: { value: 'https://stream.example.com/events' },
    });
    await user.click(screen.getByRole('button', { name: /Headers/ }));
    await user.click(screen.getByRole('button', { name: 'Add header (0)' }));
    await user.click(screen.getByRole('button', { name: 'Add param (0)' }));
    await user.click(screen.getByRole('button', { name: 'Auth: none' }));
    await user.click(screen.getByRole('switch', { name: 'Reconnect on resume (Last-Event-ID)' }));
    act(() => {
      useSseStore.getState().appendEvent(useSseStore.getState().activeConnectionId!, {
        event: 'tick',
        data: '1',
      });
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by event name' }),
      'tick'
    );

    // Scripts have no SSE editor yet; they still ride along on the tab request.
    act(() => {
      useRequestStore.getState().updateRequest({ preRequestScript: 'pm.log(1)' });
    });

    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);
    await user.type(screen.getByPlaceholderText('New collection name'), 'Streams');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(savedRequest()).toMatchObject({
      type: 'sse',
      url: 'https://stream.example.com/events',
      headers: [{ key: 'x-header', value: '{{header}}', enabled: true }],
      params: [{ key: 'x-param', value: '{{param}}', enabled: true }],
      auth: { type: 'bearer', bearer: { token: 'tok' } },
      reconnectOnResume: false,
      eventFilter: ['tick'],
      preRequestScript: 'pm.log(1)',
    });
    // The feature store holds runtime state only.
    const conn = Object.values(useSseStore.getState().connections)[0];
    expect(conn).not.toHaveProperty('url');
    expect(conn).not.toHaveProperty('headers');
  });

  it('opening a saved SSE item hydrates the builder and connects with its config', async () => {
    const user = userEvent.setup();
    const saved: SseRequest = {
      id: 'saved-sse',
      name: 'Saved stream',
      type: 'sse',
      url: 'https://saved.example.com/sse',
      headers: [{ id: 'h', key: 'X-Key', value: 'k', enabled: true }],
      params: [
        { id: 'p', key: 'topic', value: 'news', enabled: true },
        { id: 'p2', key: 'off', value: 'x', enabled: false },
      ],
      auth: { type: 'none' },
      reconnectOnResume: false,
      eventFilter: ['update'],
    };
    useRequestStore.getState().openTab(saved, { savedRequestId: 'item-1' });
    render(<SseClient />);

    expect(screen.getByRole('textbox', { name: 'SSE endpoint URL' })).toHaveValue(
      'https://saved.example.com/sse'
    );
    expect(screen.getByRole('combobox', { name: 'Filter by event name' })).toHaveValue('update');

    await user.click(screen.getByRole('button', { name: 'Start SSE stream' }));
    expect(manager.connect).toHaveBeenCalledWith(
      expect.any(String),
      'https://saved.example.com/sse?topic=news',
      { 'X-Key': 'k' },
      { reconnectOnResume: false, autoReconnect: true }
    );
    // Hydration alone is not an edit.
    expect(useRequestStore.getState().tabs[0]?.isDirty).toBe(false);
  });
});
