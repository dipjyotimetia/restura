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
});
