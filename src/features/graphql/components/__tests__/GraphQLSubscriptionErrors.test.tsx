import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/lazyComponent', async () => {
  const JsonTree = (await import('@/components/shared/JsonTree')).default;
  return { lazyComponent: () => JsonTree };
});

import type { SubscriptionLogMessage } from '@/features/graphql/lib/subscriptionLog';
import { GraphQLSubscriptionErrors } from '../GraphQLSubscriptionErrors';

const messages: SubscriptionLogMessage[] = [
  { id: 'm1', type: 'connected', timestamp: 1 },
  { id: 'm2', type: 'data', timestamp: 2, payload: { data: { tick: { n: 0 } } } },
  {
    id: 'm3',
    type: 'data',
    timestamp: 3,
    payload: {
      data: { tick: null },
      errors: [
        {
          message: 'tick exploded',
          locations: [{ line: 1, column: 16 }],
          path: ['tick'],
          extensions: { code: 'TICK_FAILED' },
        },
      ],
    },
  },
];

describe('GraphQLSubscriptionErrors', () => {
  it('renders nothing when no next payload carries errors', () => {
    const { container } = render(
      <GraphQLSubscriptionErrors messages={messages.slice(0, 2)} tabId="t" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists next-payload errors and reveals the erroring node in that event', () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<GraphQLSubscriptionErrors messages={messages} tabId="t" />);
    expect(screen.getByText('1 error in events')).toBeTruthy();
    expect(screen.getByText('tick exploded')).toBeTruthy();
    expect(screen.getByText('TICK_FAILED')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show tick in response' }));
    const flag = screen.getByRole('img', { name: 'Error: [TICK_FAILED] tick exploded' });
    expect(flag.closest('[data-highlighted]')?.textContent).toContain('"tick"');

    fireEvent.click(screen.getByRole('button', { name: 'Close payload' }));
    expect(screen.queryByRole('tree')).toBeNull();
  });
});
