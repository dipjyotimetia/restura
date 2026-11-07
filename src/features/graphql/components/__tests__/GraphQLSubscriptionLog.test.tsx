import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SubscriptionLogMessage } from '../../lib/subscriptionLog';
import { GraphQLSubscriptionLog } from '../GraphQLSubscriptionLog';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

const messages: SubscriptionLogMessage[] = [
  { id: '1', type: 'connected', protocol: 'graphql-ws', timestamp: T0 },
  { id: '2', type: 'data', payload: { n: 1 }, payloadText: '{"n":1}', timestamp: T0 + 1 },
  { id: '3', type: 'error', error: 'boom', timestamp: T0 + 2 },
  { id: '4', type: 'complete', timestamp: T0 + 3 },
];

function renderLog(props: Partial<Parameters<typeof GraphQLSubscriptionLog>[0]> = {}) {
  const onClear = vi.fn();
  const utils = render(
    <GraphQLSubscriptionLog
      messages={messages}
      isSubscribed
      exportName="subscription"
      onClear={onClear}
      {...props}
    />
  );
  return { ...utils, onClear };
}

describe('GraphQLSubscriptionLog', () => {
  it('prompts to subscribe, or waits, when there are no messages', () => {
    const { rerender, onClear } = renderLog({ messages: [], isSubscribed: false });
    expect(screen.getByText('Click Subscribe to start receiving events.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear messages' })).toBeDisabled();
    rerender(
      <GraphQLSubscriptionLog messages={[]} isSubscribed exportName="s" onClear={onClear} />
    );
    expect(screen.getByText('Waiting for messages...')).toBeInTheDocument();
  });

  it('renders each message type with payload, error and protocol', () => {
    const { container } = renderLog({ exportMeta: { url: 'wss://x' } });
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('graphql-ws')).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('{"n":1}');
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    const cards = container.querySelectorAll('.space-y-2 > div');
    expect(cards).toHaveLength(4);
    expect(cards[0]?.className).toContain('bg-blue-500/5');
    expect(cards[1]?.className).toContain('bg-emerald-500/5');
    expect(cards[2]?.className).toContain('bg-destructive/5');
    expect(cards[3]?.className).toContain('bg-sp-surface-lo');
  });

  it('filters by direction and search, with a filtered-empty hint', () => {
    const { container } = renderLog();
    const filter = screen.getByRole('combobox', { name: 'Filter messages' });
    fireEvent.change(filter, { target: { value: 'error' } });
    expect(container.querySelectorAll('.space-y-2 > div')).toHaveLength(1);
    expect(screen.getByText('boom')).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'system' } });
    expect(container.querySelectorAll('.space-y-2 > div')).toHaveLength(2);

    fireEvent.change(filter, { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No messages match the current filter.')).toBeInTheDocument();
  });

  it('calls onClear from the toolbar', () => {
    const { onClear } = renderLog();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('freezes the visible list while new messages arrive', () => {
    const { rerender, container, onClear } = renderLog({ messages: messages.slice(0, 2) });
    fireEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    rerender(
      <GraphQLSubscriptionLog
        messages={[
          ...messages.slice(0, 2),
          { id: '9', type: 'data', payload: 2, payloadText: '2', timestamp: Date.now() + 60_000 },
        ]}
        isSubscribed
        exportName="s"
        onClear={onClear}
      />
    );
    expect(container.querySelectorAll('.space-y-2 > div')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Resume live messages' }));
    expect(container.querySelectorAll('.space-y-2 > div')).toHaveLength(3);
  });
});
