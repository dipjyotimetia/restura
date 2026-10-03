import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { KeyValue } from '@/types';
import { KeyValueTable } from './KeyValueTable';

let latest: KeyValue[] = [];

function Harness({ initial, resolves }: { initial: KeyValue[]; resolves?: boolean }) {
  const [items, setItems] = useState(initial);
  latest = items;
  return (
    <KeyValueTable
      items={items}
      onChange={setItems}
      itemLabel="Kafka header"
      addLabel="Add header"
      {...(resolves && { resolvesVariables: 'connection' as const })}
    />
  );
}

const row = (over: Partial<KeyValue> = {}): KeyValue => ({
  id: 'h1',
  key: 'x-token',
  value: 'abc',
  enabled: true,
  ...over,
});

describe('KeyValueTable', () => {
  beforeEach(() => {
    latest = [];
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
  });

  it('adds an empty row from the footer button with the given label', async () => {
    render(<Harness initial={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ key: '', value: '', enabled: true });
    expect(screen.getByRole('textbox', { name: 'Kafka header key' })).toBeInTheDocument();
  });

  it('commits the ghost row with its values on Enter', () => {
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'New entry key' }), {
      target: { value: 'trace-id' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'New entry value' }), {
      target: { value: '42' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New entry value' }), { key: 'Enter' });
    expect(latest).toEqual([
      expect.objectContaining({ key: 'trace-id', value: '42', enabled: true }),
    ]);
  });

  it('edits and removes a row, keeping the others', () => {
    render(<Harness initial={[row(), row({ id: 'h2', key: 'keep' })]} />);
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Kafka header value' })[0]!, {
      target: { value: 'changed' },
    });
    expect(latest[0]).toMatchObject({ id: 'h1', value: 'changed' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0]!);
    expect(latest.map((r) => r.id)).toEqual(['h2']);
  });

  it('replaces the list from bulk edit', async () => {
    render(<Harness initial={[row()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Bulk edit' }));
    const text = screen.getByRole('textbox', { name: 'Bulk edit Kafka headers' });
    fireEvent.change(text, { target: { value: 'a: 1\n//b: 2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(latest.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', '2', false],
    ]);
  });

  it('highlights {{vars}} only when the send path resolves them', () => {
    const value = row({ value: '{{token}}' });
    const { container, unmount } = render(<Harness initial={[value]} />);
    expect(container.querySelector('[data-var]')).toBeNull();
    unmount();
    const resolved = render(<Harness initial={[value]} resolves />);
    expect(resolved.container.querySelector('[data-var]')).not.toBeNull();
  });
});
