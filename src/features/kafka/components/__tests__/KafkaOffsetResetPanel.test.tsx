import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KafkaOffsetResetPanel } from '../KafkaOffsetResetPanel';

const manager = vi.hoisted(() => ({
  resetGroupOffsets: vi.fn(),
  deleteGroupOffsets: vi.fn(),
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

const offsets = [
  { topic: 'orders', partition: 0, committed: '7', logEnd: '12', lag: '5' },
  { topic: 'orders', partition: 1, committed: null, logEnd: '0', lag: '0' },
  { topic: 'audit', partition: 0, committed: '2', logEnd: '4', lag: '2' },
];

function renderPanel(overrides: { offsets?: typeof offsets } = {}) {
  const onChanged = vi.fn(async () => {});
  const run = vi.fn((action: () => Promise<unknown>) => action());
  const view = render(
    <KafkaOffsetResetPanel
      connectionId="c1"
      groupId="g1"
      offsets={overrides.offsets ?? offsets}
      busy={false}
      run={run as never}
      onChanged={onChanged}
    />
  );
  return { ...view, onChanged };
}

describe('KafkaOffsetResetPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.resetGroupOffsets.mockResolvedValue({
      ok: true,
      offsets: [
        { topic: 'audit', partition: 0, previous: '2', offset: '0', note: 'clamped-earliest' },
      ],
      skipped: [{ topic: 'orders', partition: 1, reason: 'no-committed-offset' }],
      dryRun: true,
    });
    manager.deleteGroupOffsets.mockResolvedValue({
      ok: true,
      deleted: [{ topic: 'audit', partitions: [0] }],
    });
  });

  it('renders nothing without committed offsets', () => {
    const { container } = renderPanel({ offsets: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('previews a shift across all topics, then applies it behind a confirmation', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderPanel();
    const [scope, target] = screen.getAllByRole('combobox');
    await user.selectOptions(scope!, '*');
    // 'specific' is not offered for the all-topics scope.
    expect(screen.queryByRole('option', { name: 'specific' })).toBeNull();
    await user.selectOptions(target!, 'shift');

    const shiftInput = screen.getByLabelText('Shift by');
    await user.type(shiftInput, 'abc');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await user.clear(shiftInput);
    await user.type(shiftInput, '-5');

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(manager.resetGroupOffsets).toHaveBeenCalledWith({
        connectionId: 'c1',
        groupId: 'g1',
        allTopics: true,
        to: 'shift',
        shift: -5,
        dryRun: true,
      })
    );
    expect(await screen.findByText(/Preview \(not applied\)/)).toBeVisible();
    expect(screen.getByText(/1 skipped \(no committed offset\): orders\/P1/)).toBeVisible();
    expect(screen.getByText('clamped to earliest')).toBeVisible();
    expect(onChanged).not.toHaveBeenCalled();

    manager.resetGroupOffsets.mockResolvedValueOnce({
      ok: true,
      offsets: [{ topic: 'audit', partition: 0, previous: '2', offset: '0' }],
      skipped: [],
      dryRun: false,
    });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Confirm reset (all topics)' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(manager.resetGroupOffsets).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      groupId: 'g1',
      allTopics: true,
      to: 'shift',
      shift: -5,
    });
    expect(await screen.findByText(/Applied/)).toBeVisible();
  });

  it('resets a single topic to a date/time as epoch milliseconds', async () => {
    const user = userEvent.setup();
    renderPanel();
    const [scope, target] = screen.getAllByRole('combobox');
    await user.selectOptions(scope!, 'orders');
    await user.selectOptions(target!, 'timestamp');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    const input = screen.getByLabelText('Reset date/time');
    await user.type(input, '2026-01-02T03:04:05');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await waitFor(() =>
      expect(manager.resetGroupOffsets).toHaveBeenCalledWith({
        connectionId: 'c1',
        groupId: 'g1',
        topic: 'orders',
        to: 'timestamp',
        timestamp: new Date('2026-01-02T03:04:05').getTime(),
      })
    );
  });

  it('deletes committed offsets for the selected topic after confirmation', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderPanel();
    // Default scope is the first committed topic (sorted): audit.
    await user.click(screen.getByRole('button', { name: /Delete offsets/ }));
    await user.click(screen.getByRole('button', { name: /Confirm delete offsets \(audit\)/ }));
    await waitFor(() =>
      expect(manager.deleteGroupOffsets).toHaveBeenCalledWith({
        connectionId: 'c1',
        groupId: 'g1',
        topic: 'audit',
      })
    );
    expect(await screen.findByText('Deleted committed offsets for 1 partition(s).')).toBeVisible();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('cancels pending confirmations without mutating', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Delete offsets/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Delete offsets/ })).toBeVisible();
    expect(manager.resetGroupOffsets).not.toHaveBeenCalled();
    expect(manager.deleteGroupOffsets).not.toHaveBeenCalled();
  });

  it('switches away from specific when the all-topics scope is chosen', async () => {
    const user = userEvent.setup();
    renderPanel();
    const [scope, target] = screen.getAllByRole('combobox');
    await user.selectOptions(target!, 'specific');
    expect(screen.getByTitle('Offset for partition 0')).toHaveValue('2');
    await user.selectOptions(scope!, '*');
    expect(target).toHaveValue('latest');
    expect(screen.queryByTitle('Offset for partition 0')).toBeNull();
  });

  it('does not refresh or show an outcome when the mutations fail', async () => {
    manager.resetGroupOffsets.mockResolvedValueOnce({ ok: false, error: 'group not empty' });
    manager.deleteGroupOffsets.mockResolvedValueOnce({ ok: false, error: 'nope' });
    const user = userEvent.setup();
    const { onChanged } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(manager.resetGroupOffsets).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Delete offsets/ }));
    await user.click(screen.getByRole('button', { name: /Confirm delete offsets/ }));
    await waitFor(() => expect(manager.deleteGroupOffsets).toHaveBeenCalled());
    expect(screen.queryByTestId('kafka-offset-outcome')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
