import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KafkaGroupInspector } from '../KafkaGroupInspector';

const manager = vi.hoisted(() => ({
  inspectGroup: vi.fn(),
  resetGroupOffsets: vi.fn(),
  deleteGroup: vi.fn(),
}));

vi.mock('@/features/kafka/lib/kafkaManager', () => ({
  kafkaManager: manager,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

describe('KafkaGroupInspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.inspectGroup.mockResolvedValue({
      ok: true,
      group: {
        groupId: 'orders-workers',
        state: 'STABLE',
        protocolType: 'consumer',
        protocol: 'range',
        members: [
          {
            memberId: 'member-1',
            clientId: 'restura-consumer',
            clientHost: '/127.0.0.1',
            assignments: [{ topic: 'orders', partitions: [0, 1] }],
          },
        ],
      },
      offsets: [
        { topic: 'orders', partition: 0, committed: '7', logEnd: '12', lag: '5' },
        { topic: 'orders', partition: 1, committed: null, logEnd: '0', lag: '0' },
      ],
    });
    manager.resetGroupOffsets.mockResolvedValue({ ok: true });
    manager.deleteGroup.mockResolvedValue({ ok: true });
  });

  it('inspects members and lag, validates specific offsets, and confirms mutations', async () => {
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    const user = userEvent.setup();

    render(
      <KafkaGroupInspector
        connectionId="connection-1"
        groupId="orders-workers"
        onClose={onClose}
        onDeleted={onDeleted}
      />
    );

    expect(await screen.findByText('STABLE')).toBeVisible();
    expect(screen.getByText('restura-consumer')).toBeVisible();
    expect(screen.getByText('orders[0,1]')).toBeVisible();
    expect(screen.getByText('5')).toBeVisible();
    expect(screen.getByText('—')).toBeVisible();

    const resetMode = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(resetMode, 'specific');
    const offsetInput = screen.getByTitle('Offset for partition 0');
    await user.clear(offsetInput);
    await user.type(offsetInput, 'invalid');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    await user.clear(offsetInput);
    await user.type(offsetInput, '3');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await waitFor(() =>
      expect(manager.resetGroupOffsets).toHaveBeenCalledWith({
        connectionId: 'connection-1',
        groupId: 'orders-workers',
        topic: 'orders',
        to: 'specific',
        partitions: [
          { partition: 0, offset: '3' },
          { partition: 1, offset: '0' },
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: 'Delete group' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Close group inspector' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders idle groups with no offsets and surfaces native failures', async () => {
    manager.inspectGroup
      .mockResolvedValueOnce({
        ok: true,
        group: {
          groupId: 'idle',
          state: 'EMPTY',
          protocolType: '',
          protocol: '',
          members: [],
        },
        offsets: [],
      })
      .mockResolvedValueOnce({ ok: false, error: 'group coordinator unavailable' });

    const { rerender } = render(
      <KafkaGroupInspector
        connectionId="connection-1"
        groupId="idle"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />
    );
    expect(await screen.findByText('No active members (group is idle).')).toBeVisible();
    expect(screen.getByText('No committed offsets for this group.')).toBeVisible();

    rerender(
      <KafkaGroupInspector
        connectionId="connection-1"
        groupId="failing"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />
    );
    expect(await screen.findByText('group coordinator unavailable')).toBeVisible();
  });
});
