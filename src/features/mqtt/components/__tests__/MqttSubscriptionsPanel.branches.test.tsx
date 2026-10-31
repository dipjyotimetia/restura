import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { MqttSubscription } from '@/features/mqtt/store/useMqttStore';
import { MqttSubscriptionsPanel } from '../MqttSubscriptionsPanel';

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

function setup(
  props: Partial<React.ComponentProps<typeof MqttSubscriptionsPanel>> = {},
  subscriptions: MqttSubscription[] = []
) {
  const handlers = {
    onSubscribe: vi.fn(),
    onUnsubscribe: vi.fn(),
    onSubQosChange: vi.fn(),
    onSubTopicChange: vi.fn(),
  };
  render(
    <Tabs defaultValue="subscribe">
      <MqttSubscriptionsPanel
        isConnected
        subQos={0}
        subTopic="a/#"
        subscriptions={subscriptions}
        {...handlers}
        {...props}
      />
    </Tabs>
  );
  return handlers;
}

describe('MqttSubscriptionsPanel branches', () => {
  it('disables Subscribe when disconnected or the topic is blank and shows empty state', () => {
    setup({ isConnected: false });
    expect((screen.getByRole('button', { name: 'Subscribe' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText('No active subscriptions.')).toBeTruthy();
  });

  it('disables Subscribe for a blank topic and forwards topic and qos edits', () => {
    const handlers = setup({ subTopic: '   ' });
    expect((screen.getByRole('button', { name: 'Subscribe' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.change(screen.getByPlaceholderText(/sensors/), { target: { value: 'x' } });
    expect(handlers.onSubTopicChange).toHaveBeenCalledWith('x');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(handlers.onSubQosChange).toHaveBeenCalledWith(2);
  });

  it('lists subscriptions with granted qos, ids, no-local, and unsubscribes', () => {
    const handlers = setup({}, [
      {
        topicFilter: 'a/#',
        requestedQos: 1,
        grantedQos: 1,
        status: 'subscribed',
        subscriptionIdentifier: 4,
        options: { noLocal: true },
      },
      { topicFilter: 'b', requestedQos: 0, status: 'subscribing' },
    ]);
    expect(screen.getByText('subscribed · id 4 · no local')).toBeTruthy();
    expect(screen.getByText('subscribing')).toBeTruthy();
    expect(screen.getByText('Q1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Unsubscribe b'));
    expect(handlers.onUnsubscribe).toHaveBeenCalledWith('b');
  });

  it('v5 options toggle on and off, change retain handling and identifier', () => {
    const onSubOptionsChange = vi.fn();
    const onSubIdentifierChange = vi.fn();
    setup({
      isV5: true,
      subOptions: { noLocal: true, retainAsPublished: true, retainHandling: 1 },
      onSubOptionsChange,
      onSubIdentifierChange,
      subIdentifier: 3,
    });
    const last = () => onSubOptionsChange.mock.calls.at(-1)?.[0];
    fireEvent.click(screen.getByLabelText('No Local'));
    expect(last().noLocal).toBeUndefined();
    fireEvent.click(screen.getByLabelText('Retain as Published'));
    expect(last().retainAsPublished).toBeUndefined();
    const combos = screen.getAllByRole('combobox');
    fireEvent.change(combos[combos.length - 1] as HTMLElement, { target: { value: '2' } });
    expect(last().retainHandling).toBe(2);
    fireEvent.change(combos[combos.length - 1] as HTMLElement, { target: { value: '0' } });
    expect(last().retainHandling).toBeUndefined();
    const id = screen.getByDisplayValue('3');
    fireEvent.change(id, { target: { value: '8' } });
    expect(onSubIdentifierChange).toHaveBeenLastCalledWith(8);
    fireEvent.change(id, { target: { value: '' } });
    expect(onSubIdentifierChange).toHaveBeenLastCalledWith(undefined);
  });

  it('v5 options default off, and a missing callback is tolerated', () => {
    const onSubOptionsChange = vi.fn();
    setup({ isV5: true, onSubOptionsChange });
    fireEvent.click(screen.getByLabelText('No Local'));
    expect(onSubOptionsChange).toHaveBeenLastCalledWith({ noLocal: true });
    fireEvent.click(screen.getByLabelText('Retain as Published'));
    expect(onSubOptionsChange).toHaveBeenLastCalledWith({ retainAsPublished: true });
    fireEvent.change(screen.getByPlaceholderText('optional'), { target: { value: '5' } });
  });

  it('hides v5 options without a change handler', () => {
    setup({ isV5: true });
    expect(screen.queryByLabelText('No Local')).toBeNull();
  });
});
