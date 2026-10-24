import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { KafkaProducerPanel } from '../KafkaProducerPanel';

const api = vi.hoisted(() => ({
  registryListSubjects: vi.fn(async () => ({ success: true, subjects: [] })),
  registryListVersions: vi.fn(async () => ({ success: true, versions: [1] })),
  registryGetSchema: vi.fn(async ({ subject }: { subject: string }) => ({
    success: true,
    schema: {
      id: 1,
      subject,
      version: 1,
      schemaType: 'JSON',
      schema: JSON.stringify({ type: 'object', properties: { id: { type: 'integer' } } }),
      references: [],
    },
  })),
}));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => ({ kafka: api }),
}));
vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));

const connection: KafkaConnection = {
  id: 'connection-1',
  name: 'Kafka connection',
  clientId: 'restura-test',
  bootstrapBrokers: ['localhost:9092'],
  auth: { securityProtocol: 'PLAINTEXT' },
  status: 'connected',
  defaultTopic: 'orders',
  defaultPartitionKey: '',
  acks: 1,
  compression: 'none',
  idempotent: false,
  registry: { url: 'https://registry.example.test' },
  consumer: {
    groupId: 'restura-test',
    topics: [],
    fromBeginning: false,
    mode: 'committed',
    fallbackMode: 'latest',
    commitPolicy: 'auto',
    isolation: 'read-uncommitted',
    groupProtocol: 'classic',
    status: 'idle',
  },
  messages: [],
  createdAt: 0,
};

describe('KafkaProducerPanel — Schema Registry pickers', () => {
  it('fills the value editor (JSON mode) and a compact key from generated examples', async () => {
    const setters = {
      setProduceKey: vi.fn(),
      setProduceKeyEncoding: vi.fn(),
      setProduceValue: vi.fn(),
      setProduceValueEncoding: vi.fn(),
    };
    const noop = vi.fn();
    const user = userEvent.setup();
    render(
      <Tabs value="produce">
        <KafkaProducerPanel
          connection={connection}
          updateConnection={noop}
          produceKey=""
          produceKeyEncoding="utf8"
          produceValue=""
          produceValueEncoding="utf8"
          produceHeaders={[]}
          setProduceHeaders={noop}
          producePartition=""
          setProducePartition={noop}
          produceSchemaId=""
          setProduceSchemaId={noop}
          produceKeySchemaId=""
          setProduceKeySchemaId={noop}
          produceValueSubject={{ subject: 'orders-value', version: 'latest' }}
          setProduceValueSubject={noop}
          produceKeySubject={{ subject: 'orders-key', version: 'latest' }}
          setProduceKeySubject={noop}
          produceError={null}
          produceTombstone={false}
          setProduceTombstone={noop}
          onPublish={noop}
          {...setters}
        />
      </Tabs>
    );

    expect(await screen.findByLabelText('Value schema')).toBeVisible();
    expect(await screen.findByLabelText('Key schema')).toBeVisible();
    const [valueGenerate, keyGenerate] = screen.getAllByRole('button', {
      name: /Generate example/,
    });
    await user.click(valueGenerate!);
    expect(setters.setProduceValue).toHaveBeenCalledWith('{\n  "id": 0\n}');
    expect(setters.setProduceValueEncoding).toHaveBeenCalledWith('json');
    await user.click(keyGenerate!);
    expect(setters.setProduceKey).toHaveBeenCalledWith('{"id":0}');
    expect(setters.setProduceKeyEncoding).toHaveBeenCalledWith('json');
  });
});
