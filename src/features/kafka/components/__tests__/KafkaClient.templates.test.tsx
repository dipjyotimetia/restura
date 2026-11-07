import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaTemplateSchema } from '../../lib/kafkaTemplates';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { useKafkaStore } from '../../store/useKafkaStore';
import KafkaClient from '../KafkaClient';

const mocks = vi.hoisted(() => ({
  produceWithVariables: vi.fn(async () => ({ ok: true as const })),
  connection: null as KafkaConnection | null,
}));

vi.mock('@/features/kafka/lib/kafkaVariables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/kafka/lib/kafkaVariables')>();
  return { ...actual, produceWithVariables: mocks.produceWithVariables };
});

vi.mock('../../hooks/useKafkaConnection', () => ({
  useKafkaConnection: () => ({
    isDesktop: true,
    activeConnectionId: mocks.connection?.id ?? null,
    connection: mocks.connection,
    removeConnection: vi.fn(),
    updateConnection: (id: string, patch: Partial<KafkaConnection>) => {
      useKafkaStore.getState().updateConnection(id, patch);
      mocks.connection = useKafkaStore.getState().connections[id] ?? null;
    },
    updateConsumer: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));
vi.mock('../KafkaConnectionForm', () => ({ KafkaConnectionForm: () => null }));
vi.mock('../KafkaAdminPanel', () => ({ KafkaAdminPanel: () => null }));
vi.mock('../KafkaConsumerPanel', () => ({
  CONSUME_MODE_OPTIONS: [],
  KafkaConsumerPanel: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useKafkaStore.setState({ connections: {}, connectionByTabId: {} });
  const id = useKafkaStore.getState().ensureConnectionForTab('k-tab');
  useKafkaStore.getState().updateConnection(id, { defaultTopic: 'orders' });
  useKafkaStore.getState().updateStatus(id, 'connected');
  mocks.connection = useKafkaStore.getState().connections[id] ?? null;
});

describe('Kafka saved produce templates (S15)', () => {
  it('saves the composer as a template and sends it unresolved through produceWithVariables', async () => {
    const { rerender } = render(<KafkaClient />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Produce' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Kafka message value' }), {
      target: { value: '{"user":"{{userId}}"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    rerender(<KafkaClient />);
    const saved = mocks.connection?.templates ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Produce 1', value: '{"user":"{{userId}}"}' });
    expect(kafkaTemplateSchema.safeParse(saved[0]).success).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Send Produce 1' }));
    await waitFor(() => expect(mocks.produceWithVariables).toHaveBeenCalledOnce());
    expect(mocks.produceWithVariables).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'orders', value: '{"user":"{{userId}}"}' }),
      expect.anything()
    );
  });
});
