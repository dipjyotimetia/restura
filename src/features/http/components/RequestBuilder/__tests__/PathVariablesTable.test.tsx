import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyValue } from '@/types';
import { PathVariablesTable, usePathVariableRows } from '../PathVariablesTable';

const rows = (): KeyValue[] => [
  { id: 'a', key: 'userId', value: '42', enabled: true },
  { id: 'b', key: 'postId', value: '', enabled: true, description: 'post' },
];

describe('PathVariablesTable', () => {
  it('renders nothing when the URL has no path variables', () => {
    const { container } = render(<PathVariablesTable rows={[]} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one row per variable with a read-only key', () => {
    render(<PathVariablesTable rows={rows()} onChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Path variables' })).toBeInTheDocument();
    const keys = screen.getAllByLabelText('Path variable key');
    expect(keys.map((k) => (k as HTMLInputElement).value)).toEqual(['userId', 'postId']);
    for (const key of keys) expect(key).toHaveAttribute('readonly');
  });

  it('edits only the changed row, keeping its key', () => {
    const onChange = vi.fn();
    render(<PathVariablesTable rows={rows()} onChange={onChange} />);
    fireEvent.change(screen.getAllByLabelText('Description')[0] as HTMLElement, {
      target: { value: 'the user' },
    });
    expect(onChange).toHaveBeenCalledWith([
      { id: 'a', key: 'userId', value: '42', enabled: true, description: 'the user' },
      rows()[1],
    ]);
  });

  it('toggles a row off', () => {
    const onChange = vi.fn();
    render(<PathVariablesTable rows={rows()} onChange={onChange} />);
    fireEvent.click(
      screen.getAllByRole('switch', { name: 'Enable path variable' })[1] as HTMLElement
    );
    const next = onChange.mock.calls[0]?.[0] as KeyValue[];
    expect(next[1]).toMatchObject({ key: 'postId', enabled: false, description: 'post' });
    expect(next[0]).toEqual(rows()[0]);
  });
});

describe('usePathVariableRows', () => {
  it('derives rows from the URL and keeps values for names that remain', () => {
    const stored: KeyValue[] = [{ id: 'x', key: 'id', value: '7', enabled: true }];
    const { result, rerender } = renderHook(({ url }) => usePathVariableRows(url, stored), {
      initialProps: { url: 'https://h/users/:id' },
    });
    expect(result.current.map((r) => [r.key, r.value])).toEqual([['id', '7']]);
    rerender({ url: 'https://h/users/:id/posts/:postId' });
    expect(result.current.map((r) => [r.key, r.value])).toEqual([
      ['id', '7'],
      ['postId', ''],
    ]);
  });
});
