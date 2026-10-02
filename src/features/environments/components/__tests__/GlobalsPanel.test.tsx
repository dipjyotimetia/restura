import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { GlobalsPanel, rowsToVars, varsToRows } from '../GlobalsPanel';

describe('globals rows', () => {
  it('skips blank keys, trims, and lets the last duplicate win', () => {
    expect(
      rowsToVars([
        { id: '1', key: ' host ', value: 'a' },
        { id: '2', key: '', value: 'ignored' },
        { id: '3', key: 'host', value: 'b' },
      ])
    ).toEqual({ host: 'b' });
  });

  it('keeps row ids by key when rebuilding from the store', () => {
    const rows = varsToRows({ host: 'x', token: 'y' }, [{ id: 'keep', key: 'host', value: 'old' }]);
    expect(rows.find((r) => r.key === 'host')?.id).toBe('keep');
    expect(rows.find((r) => r.key === 'token')?.id).toBeTruthy();
  });
});

describe('GlobalsPanel', () => {
  beforeEach(() => useGlobalsStore.setState({ vars: { host: 'api.dev' } }));

  it('edits globals in place and writes the map back', () => {
    render(<GlobalsPanel />);
    const name = screen.getByRole('textbox', { name: 'Global name' });
    fireEvent.change(name, { target: { value: 'baseUrl' } });
    expect(useGlobalsStore.getState().vars).toEqual({ baseUrl: 'api.dev' });
    // Same row (no remount) — focus target is still the edited input.
    expect(screen.getByRole('textbox', { name: 'Global name' })).toBe(name);

    fireEvent.click(screen.getByRole('button', { name: 'Add global' }));
    const names = screen.getAllByRole('textbox', { name: 'Global name' });
    fireEvent.change(names[1]!, { target: { value: 'baseUrl' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Duplicate names: baseUrl');

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove baseUrl' })[1]!);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('picks up globals changed elsewhere (e.g. pm.globals.set in a script)', async () => {
    render(<GlobalsPanel />);
    await act(async () => {
      useGlobalsStore.getState().set('token', 'abc');
    });
    expect(await screen.findByDisplayValue('token')).toBeInTheDocument();
    expect(screen.getByDisplayValue('abc')).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    useGlobalsStore.setState({ vars: {} });
    render(<GlobalsPanel />);
    expect(screen.getByText('No globals yet')).toBeInTheDocument();
  });
});
