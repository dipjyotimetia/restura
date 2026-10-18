import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaSubjectSelection } from '@/features/kafka/lib/kafkaManager';
import { SchemaRegistryFieldPicker } from '../SchemaRegistryPicker';

const apiState = vi.hoisted(() => ({ available: true }));
const api = vi.hoisted(() => ({
  registryListSubjects: vi.fn(),
  registryListVersions: vi.fn(),
  registryGetSchema: vi.fn(),
}));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => (apiState.available ? { kafka: api } : undefined),
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
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const AVRO = JSON.stringify({
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'sku', type: 'string' },
  ],
});

function Harness({
  field = 'value',
  topic = 'orders',
  connected = true,
  initialSchemaId = '',
  initialSubject = null,
  onGenerate = vi.fn(),
  onSubjectSpy = vi.fn(),
  onSchemaIdSpy = vi.fn(),
}: {
  field?: 'key' | 'value';
  topic?: string;
  connected?: boolean;
  initialSchemaId?: string;
  initialSubject?: KafkaSubjectSelection | null;
  onGenerate?: (json: string) => void;
  onSubjectSpy?: (value: KafkaSubjectSelection | null) => void;
  onSchemaIdSpy?: (value: string) => void;
}) {
  const [schemaId, setSchemaId] = useState(initialSchemaId);
  const [subject, setSubject] = useState<KafkaSubjectSelection | null>(initialSubject);
  return (
    <SchemaRegistryFieldPicker
      field={field}
      connectionId="c1"
      connected={connected}
      topic={topic}
      schemaId={schemaId}
      onSchemaIdChange={(value) => {
        onSchemaIdSpy(value);
        setSchemaId(value);
      }}
      subject={subject}
      onSubjectChange={(value) => {
        onSubjectSpy(value);
        setSubject(value);
      }}
      onGenerateExample={onGenerate}
    />
  );
}

const sourceSelect = () => screen.getAllByRole('combobox')[0]!;

describe('SchemaRegistryFieldPicker', () => {
  beforeEach(() => {
    apiState.available = true;
    api.registryListSubjects.mockReset().mockResolvedValue({
      success: true,
      subjects: ['audit-value', 'orders-key', 'orders-value'],
    });
    api.registryListVersions.mockReset().mockResolvedValue({ success: true, versions: [1, 2] });
    api.registryGetSchema
      .mockReset()
      .mockImplementation(async ({ subject, version }: { subject: string; version: unknown }) => ({
        success: true,
        schema: {
          id: version === 1 ? 9 : 12,
          subject,
          version: version === 'latest' ? 2 : version,
          schemaType: subject === 'proto-value' ? 'PROTOBUF' : 'AVRO',
          schema: subject === 'proto-value' ? 'syntax = "proto3";\nmessage A {}' : AVRO,
          references: [],
        },
      }));
  });

  it('starts without a schema and explains the plain-string default', () => {
    render(<Harness />);
    expect(sourceSelect()).toHaveValue('none');
    expect(screen.getByText(/the value is sent as a plain string/)).toBeVisible();
    expect(api.registryListSubjects).not.toHaveBeenCalled();
  });

  it('defaults to the <topic>-value subject at latest and shows the schema', async () => {
    const user = userEvent.setup();
    const onSubjectSpy = vi.fn();
    render(<Harness onSubjectSpy={onSubjectSpy} />);

    await user.selectOptions(sourceSelect(), 'subject');

    expect(await screen.findByLabelText('Value schema')).toHaveTextContent('"name": "Order"');
    expect(onSubjectSpy).toHaveBeenCalledWith({ subject: 'orders-value', version: 'latest' });
    expect(screen.getByLabelText('Value subject filter')).toHaveValue('orders-value');
    expect(screen.getByRole('button', { name: 'orders-value' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('button', { name: 'audit-value' })).toBeNull();
    expect(screen.getByText('ID 12 · AVRO · orders-value v2')).toBeVisible();
    expect(screen.getByText(/resolved when you publish/)).toBeVisible();
    expect(api.registryGetSchema).toHaveBeenCalledWith({
      connectionId: 'c1',
      subject: 'orders-value',
      version: 'latest',
    });
  });

  it('filters subjects, picks another one and pins a numbered version', async () => {
    const user = userEvent.setup();
    const onSubjectSpy = vi.fn();
    render(<Harness field="key" onSubjectSpy={onSubjectSpy} />);
    await user.selectOptions(sourceSelect(), 'subject');
    await screen.findByLabelText('Key schema');

    const filter = screen.getByLabelText('Key subject filter');
    await user.clear(filter);
    await user.type(filter, 'audit');
    await user.click(screen.getByRole('button', { name: 'audit-value' }));
    expect(onSubjectSpy).toHaveBeenLastCalledWith({ subject: 'audit-value', version: 'latest' });

    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('option', { name: 'v1' })).toBeInTheDocument());
    await user.selectOptions(screen.getAllByRole('combobox')[1]!, '1');
    expect(onSubjectSpy).toHaveBeenLastCalledWith({ subject: 'audit-value', version: 1 });
    expect(await screen.findByText('ID 9 · AVRO · audit-value v1')).toBeVisible();

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(screen.getByText('No subjects match.')).toBeVisible();
  });

  it('generates an example payload from an Avro schema', async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<Harness onGenerate={onGenerate} />);
    await user.selectOptions(sourceSelect(), 'subject');
    await screen.findByLabelText('Value schema');

    await user.click(screen.getByRole('button', { name: /Generate example/ }));
    expect(JSON.parse(onGenerate.mock.calls[0]![0] as string)).toEqual({ id: 0, sku: '' });
  });

  it('shows Protobuf schemas read-only without example generation', async () => {
    render(<Harness initialSubject={{ subject: 'proto-value', version: 'latest' }} />);
    expect(await screen.findByLabelText('Value schema')).toHaveTextContent('message A {}');
    expect(screen.getByRole('button', { name: /Generate example/ })).toBeDisabled();
  });

  it('keeps the numeric schema ID path and clears it when switching away', async () => {
    const user = userEvent.setup();
    const onSchemaIdSpy = vi.fn();
    const onSubjectSpy = vi.fn();
    render(
      <Harness initialSchemaId="3" onSchemaIdSpy={onSchemaIdSpy} onSubjectSpy={onSubjectSpy} />
    );
    expect(sourceSelect()).toHaveValue('id');
    expect(screen.getByText(/Value is parsed as JSON and Confluent-encoded/)).toBeVisible();

    await user.type(screen.getByLabelText('Value schema ID'), '1');
    expect(onSchemaIdSpy).toHaveBeenLastCalledWith('31');

    await user.selectOptions(sourceSelect(), 'none');
    expect(onSchemaIdSpy).toHaveBeenLastCalledWith('');
    expect(onSubjectSpy).toHaveBeenLastCalledWith(null);
  });

  it('surfaces registry errors and refreshes on demand', async () => {
    api.registryListSubjects.mockResolvedValueOnce({
      success: false,
      error: 'Schema Registry responded 401',
    });
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(await screen.findByText('Schema Registry responded 401')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refresh value subjects' }));
    expect(await screen.findByRole('button', { name: 'orders-value' })).toBeVisible();
  });

  it('reports version / schema lookup failures', async () => {
    api.registryGetSchema.mockResolvedValue({ success: false, error: 'Subject not found.' });
    render(<Harness initialSubject={{ subject: 'gone-value', version: 4 }} />);
    expect(await screen.findByText('Subject not found.')).toBeVisible();
  });

  it('does not browse while disconnected', async () => {
    const user = userEvent.setup();
    render(<Harness connected={false} />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(screen.getByText('Connect to browse registry subjects.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh value subjects' })).toBeDisabled();
    expect(api.registryListSubjects).not.toHaveBeenCalled();
  });

  it('handles empty registry payloads, no topic and default errors', async () => {
    api.registryListSubjects.mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    render(<Harness topic="" />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(screen.getByLabelText('Value subject filter')).toHaveAttribute(
      'placeholder',
      'Filter subjects'
    );
    expect(await screen.findByText('No subjects match.')).toBeVisible();

    api.registryListSubjects.mockResolvedValueOnce({ success: false });
    await user.click(screen.getByRole('button', { name: 'Refresh value subjects' }));
    expect(await screen.findByText('Could not list subjects.')).toBeVisible();
  });

  it('reports version-list failures and tolerates missing versions', async () => {
    api.registryListVersions.mockResolvedValueOnce({ success: false, error: 'versions down' });
    const { unmount } = render(
      <Harness initialSubject={{ subject: 'orders-value', version: 2 }} />
    );
    expect(await screen.findByText('versions down')).toBeVisible();
    unmount();

    api.registryListVersions.mockResolvedValueOnce({ success: true });
    render(<Harness initialSubject={{ subject: 'orders-value', version: 'latest' }} />);
    expect(await screen.findByLabelText('Value schema')).toBeVisible();
    expect(screen.queryByRole('option', { name: 'v1' })).toBeNull();
  });

  it('shows an error when the example cannot be generated', async () => {
    api.registryGetSchema.mockResolvedValue({
      success: true,
      schema: {
        id: 5,
        subject: 'bad-value',
        version: 1,
        schemaType: 'JSON',
        schema: '{not json',
        references: [],
      },
    });
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(
      <Harness onGenerate={onGenerate} initialSubject={{ subject: 'bad-value', version: 1 }} />
    );
    await screen.findByLabelText('Value schema');
    await user.click(screen.getByRole('button', { name: /Generate example/ }));
    expect(screen.getByText('The schema is not valid JSON.')).toBeVisible();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('explains key schema IDs and works without the Electron bridge', async () => {
    apiState.available = false;
    const user = userEvent.setup();
    render(<Harness field="key" initialSchemaId="2" />);
    expect(screen.getByText(/requires a key; decoded on consume/)).toBeVisible();
    expect(screen.getByLabelText('Key schema ID')).toHaveAttribute(
      'placeholder',
      'e.g. 2 — encode the key with this registry schema'
    );
    await user.clear(screen.getByLabelText('Key schema ID'));
    expect(screen.getByText('No schema ID — the key is sent as a plain string.')).toBeVisible();
    await user.selectOptions(sourceSelect(), 'subject');
    await user.click(screen.getByRole('button', { name: 'Refresh key subjects' }));
    expect(api.registryListSubjects).not.toHaveBeenCalled();
  });

  it('surfaces thrown IPC failures as alerts', async () => {
    api.registryListSubjects.mockRejectedValueOnce(new Error('IPC exploded'));
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(await screen.findByRole('alert')).toHaveTextContent('IPC exploded');
  });

  it('surfaces thrown version / schema lookups with fallbacks', async () => {
    api.registryListVersions.mockRejectedValueOnce('nope');
    api.registryGetSchema.mockRejectedValueOnce(new Error('schema IPC failed'));
    render(<Harness initialSubject={{ subject: 'orders-value', version: 'latest' }} />);
    expect(await screen.findByText('Could not list versions.')).toBeVisible();
    expect(await screen.findByText('schema IPC failed')).toBeVisible();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('uses default messages when the registry omits error text', async () => {
    api.registryListVersions.mockResolvedValueOnce({ success: false });
    api.registryGetSchema.mockResolvedValueOnce({ success: false });
    render(<Harness initialSubject={{ subject: 'orders-value', version: 3 }} />);
    expect(await screen.findByText('Could not list versions.')).toBeVisible();
    expect(await screen.findByText('Could not load the schema.')).toBeVisible();
  });

  it('does not refetch the versions list when only the version changes', async () => {
    const user = userEvent.setup();
    render(<Harness initialSubject={{ subject: 'orders-value', version: 'latest' }} />);
    await screen.findByText('ID 12 · AVRO · orders-value v2');
    await waitFor(() => expect(screen.getByRole('option', { name: 'v1' })).toBeInTheDocument());
    await user.selectOptions(screen.getAllByRole('combobox')[1]!, '1');
    expect(await screen.findByText('ID 9 · AVRO · orders-value v1')).toBeVisible();
    expect(api.registryListVersions).toHaveBeenCalledTimes(1);
    expect(api.registryGetSchema).toHaveBeenCalledTimes(2);
  });

  it('re-syncs the filter with the topic and reloads subjects after reconnecting', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness />);
    await user.selectOptions(sourceSelect(), 'subject');
    await screen.findByLabelText('Value schema');
    expect(api.registryListSubjects).toHaveBeenCalledTimes(1);

    rerender(<Harness connected={false} />);
    expect(screen.queryByRole('list', { name: 'Value subjects' })).toBeNull();
    expect(screen.queryByLabelText('Value schema')).toBeNull();
    rerender(<Harness connected />);
    await waitFor(() => expect(api.registryListSubjects).toHaveBeenCalledTimes(2));

    await user.selectOptions(sourceSelect(), 'none');
    rerender(<Harness topic="payments" />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(screen.getByLabelText('Value subject filter')).toHaveValue('payments-value');
  });

  it('caps the visible subject list and says so', async () => {
    api.registryListSubjects.mockResolvedValueOnce({
      success: true,
      subjects: Array.from({ length: 150 }, (_, i) => `s-${String(i).padStart(3, '0')}`),
    });
    const user = userEvent.setup();
    render(<Harness topic="" />);
    await user.selectOptions(sourceSelect(), 'subject');
    expect(await screen.findByText(/Showing first 100 of 150 subjects/)).toBeVisible();
    const list = screen.getByRole('list', { name: 'Value subjects' });
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list.querySelectorAll('li')).toHaveLength(100);
  });

  it('ignores subject lists that arrive after a disconnect or a newer refresh', async () => {
    let finishStale!: (value: unknown) => void;
    api.registryListSubjects.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStale = resolve;
        })
    );
    const user = userEvent.setup();
    const { rerender } = render(<Harness topic="" />);
    await user.selectOptions(sourceSelect(), 'subject');
    rerender(<Harness topic="" connected={false} />);
    finishStale({ success: true, subjects: ['stale-subject'] });
    rerender(<Harness topic="" connected />);
    expect(await screen.findByRole('button', { name: 'orders-value' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'stale-subject' })).toBeNull();

    // Overlapping refreshes: the older response must not win.
    let finishOld!: (value: unknown) => void;
    api.registryListSubjects
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValueOnce({ success: true, subjects: ['newest-subject'] });
    await user.click(screen.getByRole('button', { name: 'Refresh value subjects' }));
    await user.click(screen.getByRole('button', { name: 'Refresh value subjects' }));
    expect(await screen.findByRole('button', { name: 'newest-subject' })).toBeVisible();
    finishOld({ success: false, error: 'old failure' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('button', { name: 'newest-subject' })).toBeVisible();
    expect(screen.queryByText('old failure')).toBeNull();
  });
});
