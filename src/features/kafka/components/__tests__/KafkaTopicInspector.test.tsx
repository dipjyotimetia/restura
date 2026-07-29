import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KafkaTopicInspector } from '../KafkaTopicInspector';

const manager = vi.hoisted(() => ({
  inspectTopic: vi.fn(),
}));

vi.mock('@/features/kafka/lib/kafkaManager', () => ({
  kafkaManager: manager,
}));

describe('KafkaTopicInspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows partition watermarks and reveals broker-default configuration on demand', async () => {
    manager.inspectTopic.mockResolvedValue({
      ok: true,
      partitions: [
        { partition: 0, low: '2', high: '12', count: '10' },
        { partition: 1, low: '0', high: '5', count: '5' },
      ],
      config: [
        {
          name: 'cleanup.policy',
          value: 'compact',
          source: 'DYNAMIC_TOPIC_CONFIG',
          isDefault: false,
          isSensitive: false,
        },
        {
          name: 'ssl.keystore.password',
          value: 'secret',
          source: 'DEFAULT_CONFIG',
          isDefault: true,
          isSensitive: true,
        },
        {
          name: 'retention.ms',
          value: null,
          source: 'DEFAULT_CONFIG',
          isDefault: true,
          isSensitive: false,
        },
      ],
    });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<KafkaTopicInspector connectionId="connection-1" topic="orders" onClose={onClose} />);

    expect(await screen.findByText('~15 messages')).toBeVisible();
    expect(screen.getByText('P0')).toBeVisible();
    expect(screen.getByText('cleanup.policy')).toBeVisible();
    expect(screen.queryByText('ssl.keystore.password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch'));
    expect(screen.getByText('ssl.keystore.password')).toBeVisible();
    expect(screen.getByText('••••••')).toBeVisible();
    expect(screen.getByText('∅')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(manager.inspectTopic).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Close topic inspector' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders empty broker responses without leaving loading placeholders behind', async () => {
    manager.inspectTopic.mockResolvedValue({
      ok: true,
      partitions: [],
      config: [],
    });

    render(<KafkaTopicInspector connectionId="connection-1" topic="empty" onClose={vi.fn()} />);

    expect(await screen.findByText('No partitions.')).toBeVisible();
    expect(screen.getByText(/No non-default config/)).toBeVisible();
  });

  it('surfaces native inspection failures inline', async () => {
    manager.inspectTopic.mockResolvedValue({ ok: false, error: 'broker unavailable' });

    render(<KafkaTopicInspector connectionId="connection-1" topic="orders" onClose={vi.fn()} />);

    expect(await screen.findByText('broker unavailable')).toBeVisible();
  });
});
