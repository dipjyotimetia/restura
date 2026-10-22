import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpNotificationEntry } from '@/features/mcp/lib/mcpNotifications';
import { McpDiscoveryPanel } from '../McpDiscoveryPanel';
import { McpNotificationsPanel } from '../McpNotificationsPanel';

let seq = 0;
function entry(partial: Partial<McpNotificationEntry>): McpNotificationEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    timestamp: 0,
    kind: 'other',
    method: 'notifications/x',
    summary: 'x',
    ...partial,
  };
}

describe('McpNotificationsPanel', () => {
  it('shows an empty state and a disabled clear button', () => {
    render(<McpNotificationsPanel entries={[]} onClear={vi.fn()} />);
    expect(screen.getByText('No server events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear/i })).toBeDisabled();
  });

  it('renders each event kind, progress bars and details', () => {
    const onClear = vi.fn();
    render(
      <McpNotificationsPanel
        onClear={onClear}
        entries={[
          entry({
            kind: 'progress',
            summary: 'slow: step 2',
            progress: { key: 'k', value: 2, total: 4 },
          }),
          entry({ kind: 'progress', summary: 'open-ended', progress: { key: 'k2', value: 5 } }),
          entry({ kind: 'log', level: 'error', summary: 'db down', detail: '{"code":1}' }),
          entry({ kind: 'log', level: 'warning', summary: 'slow' }),
          entry({ kind: 'log', level: 'debug', summary: 'trace' }),
          entry({ kind: 'log', summary: 'no level' }),
          entry({ kind: 'list_changed', summary: 'tools list changed' }),
          entry({ kind: 'resource_updated', summary: 'a://1 updated' }),
          entry({ kind: 'subscription_closed', summary: 'ended' }),
          entry({ kind: 'error', summary: 'boom' }),
          entry({ kind: 'close', summary: 'Connection closed: stream ended' }),
          entry({ kind: 'other', summary: 'custom' }),
        ]}
      />
    );

    expect(screen.getByText('12 EVENTS')).toBeInTheDocument();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('2/4')).toBeInTheDocument();
    expect(screen.getByText('{"code":1}')).toBeInTheDocument();
    for (const label of [
      'ERROR',
      'WARNING',
      'DEBUG',
      'LOG',
      'LIST',
      'UPDATED',
      'UNSUB',
      'CLOSED',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe('McpDiscoveryPanel server events + subscriptions', () => {
  const base = {
    tools: [],
    resources: [{ uri: 'a://1', name: 'one' }],
    prompts: [],
    log: [],
    selectedToolName: null,
    selectedPromptName: null,
    onToolSelect: vi.fn(),
    onPromptSelect: vi.fn(),
    onReadResource: vi.fn(async () => undefined),
    onClearLog: vi.fn(),
    onHide: vi.fn(),
    onTabChange: vi.fn(),
  };

  it('hides the Events tab and Subscribe toggle without desktop support', () => {
    render(<McpDiscoveryPanel {...base} tab="resources" />);
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
  });

  it('renders the Events tab with the notifications pane', () => {
    const onClear = vi.fn();
    render(
      <McpDiscoveryPanel
        {...base}
        tab="events"
        events={{ entries: [entry({ kind: 'log', summary: 'hello' })], onClear }}
      />
    );
    expect(screen.getByText('Events')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('toggles a resource subscription', async () => {
    const onToggle = vi.fn(async () => undefined);
    const { rerender } = render(
      <McpDiscoveryPanel
        {...base}
        tab="resources"
        resourceSubscriptions={{ subscribed: [], onToggle }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe to a://1' }));
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('a://1', true));

    rerender(
      <McpDiscoveryPanel
        {...base}
        tab="resources"
        resourceSubscriptions={{ subscribed: ['a://1'], onToggle }}
      />
    );
    const unsubscribe = screen.getByRole('button', { name: 'Unsubscribe from a://1' });
    expect(unsubscribe).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(unsubscribe);
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('a://1', false));
  });
});
