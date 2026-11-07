import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Collection, CollectionItem, HttpRequest } from '@/types';
import type { CollectionRequestResult, RunProgress } from '../../lib/collectionRunner';
import { CollectionRunnerDialog } from '../CollectionRunnerDialog';

const hook = vi.hoisted(() => ({
  running: false,
  progress: null as RunProgress | null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../hooks/useCollectionRun', () => ({ useCollectionRun: () => hook }));

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const loadDataFile = vi.hoisted(() => vi.fn());
vi.mock('../../lib/dataLoader', () => ({ loadDataFile }));

// Radix Select cannot be driven in jsdom; use a native stand-in.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
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

const http = (id: string, method = 'GET'): HttpRequest => ({
  id,
  name: id,
  type: 'http',
  method: method as HttpRequest['method'],
  url: `https://api.test/${id}`,
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

const reqItem = (id: string, name: string, request: unknown): CollectionItem =>
  ({ id, name, type: 'request', request }) as CollectionItem;

const collection: Collection = {
  id: 'c',
  name: 'API',
  items: [
    reqItem('a', 'List users', http('ra')),
    reqItem('b', 'Create user', http('rb', 'POST')),
    {
      id: 'f',
      name: 'Admin',
      type: 'folder',
      items: [
        reqItem('g', 'Query', { ...http('rg'), type: 'graphql', query: '{ a }', variables: '' }),
        reqItem('k', 'Broker', { id: 'rk', name: 'Broker', type: 'kafka' }),
      ],
    },
  ],
};

function result(over: Partial<CollectionRequestResult> = {}): CollectionRequestResult {
  return {
    itemId: 'a',
    itemName: 'List users',
    protocol: 'http',
    iteration: 0,
    status: 'success',
    httpStatus: 200,
    durationMs: 5,
    assertions: [],
    ...over,
  };
}

const runButton = () => screen.getByRole('button', { name: /^Run \d+ request/ });

describe('CollectionRunnerDialog', () => {
  beforeEach(() => {
    hook.running = false;
    hook.progress = null;
    hook.start.mockReset();
    hook.stop.mockReset();
    toast.error.mockReset();
    toast.warning.mockReset();
    loadDataFile.mockReset();
    useCollectionStore.setState({ collections: [collection] });
    useEnvironmentStore.setState({
      environments: [{ id: 'env1', name: 'Staging', variables: [] }] as never,
      activeEnvironmentId: 'env1',
    });
  });

  it('renders nothing visible without a scope', () => {
    render(<CollectionRunnerDialog scope={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the runnable requests of the collection and reports skipped presets', () => {
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.getByText(/Run collection — API/)).toBeTruthy();
    expect(screen.getByText('List users')).toBeTruthy();
    expect(screen.getByText('Create user')).toBeTruthy();
    expect(screen.getByText('Query')).toBeTruthy();
    expect(screen.queryByText('Broker')).toBeNull();
    expect(screen.getByText('POST')).toBeTruthy();
    expect(screen.getByText('GQL')).toBeTruthy();
    expect(runButton().textContent).toContain('Run 3 requests');
    expect(screen.getByText(/1 connection preset \(Kafka/)).toBeTruthy();
    // Environment defaults to the active one.
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('env1');
  });

  it('scopes to a folder and names it', () => {
    render(
      <CollectionRunnerDialog scope={{ collectionId: 'c', folderId: 'f' }} onClose={vi.fn()} />
    );
    expect(screen.getByText(/Run folder — Admin/)).toBeTruthy();
    expect(runButton().textContent).toContain('Run 1 request');
    expect(runButton().textContent).not.toContain('requests');
  });

  it('falls back to the collection name for an unknown folder', () => {
    render(
      <CollectionRunnerDialog scope={{ collectionId: 'c', folderId: 'gone' }} onClose={vi.fn()} />
    );
    expect(screen.getByText(/Run folder — API/)).toBeTruthy();
  });

  it('shows an empty state for an unknown collection and disables Run', () => {
    render(<CollectionRunnerDialog scope={{ collectionId: 'nope' }} onClose={vi.fn()} />);
    expect(screen.getByText('No requests in this scope.')).toBeTruthy();
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('pluralises several skipped presets', () => {
    useCollectionStore.setState({
      collections: [
        {
          ...collection,
          items: [
            ...collection.items,
            reqItem('m', 'Mqtt', { id: 'rm', name: 'Mqtt', type: 'mqtt' }),
          ],
        },
      ],
    });
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.getByText(/2 connection presets \(Kafka/)).toBeTruthy();
  });

  it('toggles, reorders and starts the selected requests with the configuration', () => {
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    const [env, retention] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(env!, { target: { value: 'none' } });
    fireEvent.change(retention!, { target: { value: 'failures' } });
    const [iterations, delay] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.change(iterations!, { target: { value: '3' } });
    fireEvent.change(delay!, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stop on failure' }));

    // Deselect "Create user", then move "Query" to the top.
    const boxes = screen.getAllByRole('checkbox').filter((b) => b.id !== 'cr-stop-on-failure');
    fireEvent.click(boxes[1]!);
    expect(runButton().textContent).toContain('Run 2 requests');
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[1]!);
    const ups = screen.getAllByRole('button', { name: 'Move up' }) as HTMLButtonElement[];
    const downs = screen.getAllByRole('button', { name: 'Move down' }) as HTMLButtonElement[];
    expect(ups[0]!.disabled).toBe(true);
    expect(downs[2]!.disabled).toBe(true);
    fireEvent.click(ups[2]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]!);
    fireEvent.click(runButton());

    expect(hook.start).toHaveBeenCalledTimes(1);
    const args = hook.start.mock.calls[0]![0];
    expect(args).toMatchObject({
      scopeName: 'API',
      environmentId: 'none',
      iterations: 3,
      delayMs: 25,
      stopOnFailure: true,
      retention: 'failures',
      dataRows: [],
    });
    expect(args.runnables.map((r: { itemId: string }) => r.itemId)).toEqual(['g', 'a']);
  });

  it('clamps iterations and delay to their minimums', () => {
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    const [iterations, delay] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.change(iterations!, { target: { value: '-2' } });
    fireEvent.change(delay!, { target: { value: 'abc' } });
    expect(iterations!.value).toBe('1');
    expect(delay!.value).toBe('0');
    fireEvent.change(delay!, { target: { value: '-9' } });
    expect(delay!.value).toBe('0');
  });

  it('applies an initial rerun configuration and filters unknown ids', () => {
    render(
      <CollectionRunnerDialog
        scope={{ collectionId: 'c' }}
        onClose={vi.fn()}
        initialConfig={{
          selectedIds: ['b', 'zzz'],
          environmentId: 'env1',
          iterations: 4,
          delayMs: 10,
          stopOnFailure: true,
          retention: 'all',
        }}
      />
    );
    expect(runButton().textContent).toContain('Run 1 request');
    const [iterations, delay] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(iterations!.value).toBe('4');
    expect(delay!.value).toBe('10');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('all');
    fireEvent.click(runButton());
    expect(hook.start.mock.calls[0]![0].runnables.map((r: { itemId: string }) => r.itemId)).toEqual(
      ['b']
    );
  });

  it('requires the original data file before a data-driven rerun', async () => {
    loadDataFile.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    render(
      <CollectionRunnerDialog
        scope={{ collectionId: 'c' }}
        onClose={vi.fn()}
        initialConfig={{ usedDataFile: true }}
      />
    );
    expect(screen.getByText(/This rerun used a data file originally/)).toBeTruthy();
    fireEvent.click(runButton());
    expect(toast.warning).toHaveBeenCalledWith(
      'Choose the original CSV or JSON data file before rerunning'
    );
    expect(hook.start).not.toHaveBeenCalled();

    const input = screen.getByLabelText('Data file (CSV / JSON)') as HTMLInputElement;
    const file = new File(['id\n1\n2'], 'rows.csv', { type: 'text/csv' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await screen.findByText('rows.csv (2 rows)');
    expect(screen.queryByText(/This rerun used a data file originally/)).toBeNull();
    expect(screen.getByText('(data file overrides)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Replace/ })).toBeTruthy();
    expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(runButton());
    expect(hook.start.mock.calls[0]![0].dataRows).toEqual([{ id: '1' }, { id: '2' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear data file' }));
    expect(screen.queryByText('rows.csv (2 rows)')).toBeNull();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeTruthy();
  });

  it('opens the file picker from the Upload button and ignores an empty selection', async () => {
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    const input = screen.getByLabelText('Data file (CSV / JSON)') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: /Upload/ }));
    expect(click).toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(input, { target: { files: [] } });
    });
    expect(loadDataFile).not.toHaveBeenCalled();
  });

  it('reports a data file that fails to parse', async () => {
    loadDataFile.mockRejectedValueOnce(new Error('bad csv')).mockRejectedValueOnce('weird');
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    const input = screen.getByLabelText('Data file (CSV / JSON)') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'x.csv')] } });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to parse data file: bad csv')
    );
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'y.json')] } });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith('Failed to parse data file: weird')
    );
  });

  it('shows live progress while running and stops', () => {
    hook.running = true;
    hook.progress = {
      completed: 1,
      total: 4,
      current: { itemName: 'Create user', iteration: 0 },
      results: [result()],
      done: false,
    };
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.getByText('Running Create user…')).toBeTruthy();
    expect(screen.getByText('1 / 4')).toBeTruthy();
    expect(screen.queryByText(/Stop finishes the in-flight request/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(hook.stop).toHaveBeenCalled();
  });

  it('estimates the total before the first progress event', () => {
    hook.running = true;
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.getByText('Starting…')).toBeTruthy();
    expect(screen.getByText('0 / 3')).toBeTruthy();
  });

  it('summarises a finished run with per-result details', () => {
    hook.progress = {
      completed: 4,
      total: 4,
      results: [
        result({
          assertions: [
            { name: 'a', passed: true },
            { name: 'b', passed: false },
          ],
        }),
        result({
          itemId: 'b',
          itemName: 'Create user',
          status: 'failed',
          httpStatus: 500,
          durationMs: undefined,
          iteration: 1,
        }),
        result({
          itemId: 'g',
          itemName: 'Query',
          protocol: 'weird',
          status: 'skipped',
          httpStatus: undefined,
          durationMs: undefined,
          skippedReason: 'nope',
        }),
        result({
          itemId: 'x',
          itemName: 'Pending',
          protocol: 'grpc',
          status: 'pending' as never,
          httpStatus: undefined,
          durationMs: undefined,
        }),
      ],
      done: true,
    };
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('1 passed')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText('1 skipped')).toBeTruthy();
    expect(screen.getByText('1/2 ✓')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('5ms')).toBeTruthy();
    expect(screen.getByText('skip')).toBeTruthy();
    expect(screen.getByText('WEIRD')).toBeTruthy();
    expect(screen.getByText('gRPC')).toBeTruthy();
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(3);
  });

  it('omits skipped count and iteration badges for a simple finished run', () => {
    hook.progress = { completed: 1, total: 1, results: [result()], done: true };
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.queryByText(/^\d+ skipped$/)).toBeNull();
    expect(screen.queryByText('#1')).toBeNull();
  });

  it('closes when idle', () => {
    const onClose = vi.fn();
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clears the close-blocked notice once the run stops', () => {
    hook.running = true;
    const { rerender } = render(
      <CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByText('Stop the run to close this dialog.')).toBeTruthy();
    hook.running = false;
    rerender(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={vi.fn()} />);
    expect(screen.queryByText('Stop the run to close this dialog.')).toBeNull();
  });
});
