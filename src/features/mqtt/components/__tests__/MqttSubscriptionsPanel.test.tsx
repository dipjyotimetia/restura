import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { MqttSubscriptionsPanel } from '../MqttSubscriptionsPanel';

describe('MqttSubscriptionsPanel', () => {
  it('delegates a valid subscription request without owning the manager lifecycle', () => {
    const onSubscribe = vi.fn();

    render(
      <Tabs defaultValue="subscribe">
        <MqttSubscriptionsPanel
          isConnected
          onSubscribe={onSubscribe}
          onUnsubscribe={vi.fn()}
          subQos={1}
          subTopic=" sensors/# "
          subscriptions={[]}
          onSubQosChange={vi.fn()}
          onSubTopicChange={vi.fn()}
        />
      </Tabs>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));

    expect(onSubscribe).toHaveBeenCalledOnce();
  });

  it('offers MQTT 5 subscription options only on v5 connections (MQTT-3)', () => {
    const onSubOptionsChange = vi.fn();
    const onSubIdentifierChange = vi.fn();
    const props = {
      isConnected: true,
      onSubscribe: vi.fn(),
      onUnsubscribe: vi.fn(),
      subQos: 1 as const,
      subTopic: 'a/#',
      subscriptions: [
        {
          topicFilter: 'a/#',
          requestedQos: 1 as const,
          status: 'subscribed' as const,
          subscriptionIdentifier: 7,
          options: { noLocal: true },
        },
      ],
      onSubQosChange: vi.fn(),
      onSubTopicChange: vi.fn(),
      onSubOptionsChange,
      onSubIdentifierChange,
    };
    const { rerender } = render(
      <Tabs defaultValue="subscribe">
        <MqttSubscriptionsPanel {...props} isV5={false} />
      </Tabs>
    );
    expect(screen.queryByLabelText('No Local')).toBeNull();

    rerender(
      <Tabs defaultValue="subscribe">
        <MqttSubscriptionsPanel {...props} isV5 />
      </Tabs>
    );
    fireEvent.click(screen.getByLabelText('No Local'));
    expect(onSubOptionsChange).toHaveBeenCalledWith({ noLocal: true });
    fireEvent.change(screen.getByPlaceholderText('optional'), { target: { value: '42' } });
    expect(onSubIdentifierChange).toHaveBeenCalledWith(42);
    expect(screen.getByText('id 7')).toBeTruthy();
  });
});
