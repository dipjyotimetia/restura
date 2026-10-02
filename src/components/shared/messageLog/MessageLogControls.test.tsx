import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogDirection, LogEntry } from '@/lib/shared/messageLog';
import {
  FreezeToggle,
  LogExportMenu,
  MessageLogToolbar,
  useFrozenView,
} from './MessageLogControls';

const entry = (id: string, direction: LogEntry['direction'] = 'in'): LogEntry => ({
  id,
  timestamp: 0,
  direction,
  body: `{"id":"${id}"}`,
});

afterEach(() => vi.restoreAllMocks());

describe('useFrozenView', () => {
  const at = (id: string, timestamp: number, body = id): LogEntry => ({
    id,
    timestamp,
    direction: 'in',
    body,
  });

  it('holds what had arrived at freeze time, counts the rest, and still applies new filters', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const early = [at('a', 500, 'tick'), at('b', 900, 'tock')];
    const { result, rerender } = renderHook(
      ({ entries, frozen }) => useFrozenView(entries, frozen),
      { initialProps: { entries: early, frozen: false } }
    );
    expect(result.current.visible.map((e) => e.id)).toEqual(['a', 'b']);

    rerender({ entries: early, frozen: true });
    const later = [...early, at('c', 1500, 'tick'), at('d', 1600, 'tock')];
    rerender({ entries: later, frozen: true });
    expect(result.current.visible.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.newCount).toBe(2);

    // Searching while frozen narrows the frozen view; post-freeze rows stay hidden.
    rerender({ entries: later.filter((e) => e.body === 'tick'), frozen: true });
    expect(result.current.visible.map((e) => e.id)).toEqual(['a']);
    expect(result.current.newCount).toBe(1);

    rerender({ entries: later, frozen: false });
    expect(result.current.visible.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.newCount).toBe(0);
  });
});

it('cuts off on the very render that freezes (no unfrozen frame)', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const entries: LogEntry[] = [
    { id: 'a', timestamp: 900, direction: 'in', body: 'a' },
    { id: 'b', timestamp: 1500, direction: 'in', body: 'b' },
  ];
  // Record every committed (painted) render — a render React discards to
  // apply a render-phase state update never reaches the screen.
  const frozenRenders: string[][] = [];
  const { rerender } = renderHook(
    ({ frozen }) => {
      const view = useFrozenView(entries, frozen);
      useLayoutEffect(() => {
        if (frozen) frozenRenders.push(view.visible.map((e) => e.id));
      });
      return view;
    },
    { initialProps: { frozen: false } }
  );
  rerender({ frozen: true });
  expect(frozenRenders.length).toBeGreaterThan(0);
  for (const ids of frozenRenders) expect(ids).toEqual(['a']);
});

describe('FreezeToggle', () => {
  it('toggles and shows the new-message count only while frozen', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FreezeToggle frozen={false} newCount={3} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText('3 new')).not.toBeInTheDocument();

    rerender(<FreezeToggle frozen newCount={3} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Resume live messages' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('3 new')).toBeInTheDocument();
  });
});

describe('LogExportMenu', () => {
  it('downloads NDJSON named after the connection', async () => {
    const createUrl = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let downloaded = '';
    click.mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });

    render(<LogExportMenu entries={() => [entry('a'), entry('b')]} name="host-ws" />);
    await userEvent.click(screen.getByRole('button', { name: 'Download messages' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /NDJSON/ }));

    expect(downloaded).toBe('host-ws.ndjson');
    const blob = (createUrl.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/x-ndjson');
    expect((await blob.text()).trim().split('\n')).toHaveLength(2);
  });

  it('can be disabled', () => {
    render(<LogExportMenu entries={() => []} name="x" label="Download events" disabled />);
    expect(screen.getByRole('button', { name: 'Download events' })).toBeDisabled();
  });
});

describe('MessageLogToolbar', () => {
  function Harness({ onClear }: { onClear: () => void }) {
    const [query, setQuery] = useState('');
    const [direction, setDirection] = useState<LogDirection | 'all'>('all');
    const [frozen, setFrozen] = useState(false);
    return (
      <>
        <MessageLogToolbar
          query={query}
          onQueryChange={setQuery}
          direction={direction}
          onDirectionChange={setDirection}
          directions={['in', 'out']}
          frozen={frozen}
          newCount={0}
          onFrozenChange={setFrozen}
          exportEntries={() => []}
          exportName="stream"
          onClear={onClear}
          hasEntries
        />
        <output>{`${query}|${direction}|${frozen}`}</output>
      </>
    );
  }

  it('wires search, freeze and clear', async () => {
    const onClear = vi.fn();
    render(<Harness onClear={onClear} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search messages' }), 'tick');
    await userEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('tick|all|true');
    expect(onClear).toHaveBeenCalledOnce();
  });
});
