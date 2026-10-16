import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GRAPHQL_SUBSCRIPTION_PROTOCOLS } from '@/types';
import {
  SUBSCRIPTION_PROTOCOL_LABELS,
  SubscriptionProtocolSelect,
} from '../SubscriptionProtocolSelect';

describe('SubscriptionProtocolSelect', () => {
  it('defaults to auto when the request has no setting', () => {
    render(<SubscriptionProtocolSelect value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Subscription protocol' })).toHaveTextContent(
      SUBSCRIPTION_PROTOCOL_LABELS.auto
    );
  });

  it('shows the persisted protocol and can be disabled while subscribed', () => {
    render(<SubscriptionProtocolSelect value="graphql-sse" onChange={vi.fn()} disabled />);
    const trigger = screen.getByRole('combobox', { name: 'Subscription protocol' });
    expect(trigger).toHaveTextContent(SUBSCRIPTION_PROTOCOL_LABELS['graphql-sse']);
    expect(trigger).toBeDisabled();
  });

  it('labels every protocol', () => {
    for (const p of GRAPHQL_SUBSCRIPTION_PROTOCOLS) {
      expect(SUBSCRIPTION_PROTOCOL_LABELS[p]).toBeTruthy();
    }
  });
});
