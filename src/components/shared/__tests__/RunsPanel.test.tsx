import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { type LoadTestRun, useLoadTestStore } from '@/store/useLoadTestStore';
import { useMockStore } from '@/store/useMockStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useUiStore } from '@/store/useUiStore';
import { RunsPanel } from '../RunsPanel';

const platform = vi.hoisted(() => ({
  electron: true,
  api: null as null | { mock?: { stop: ReturnType<typeof vi.fn> } },
}));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// Stub the lazily-loaded runner so we can observe the rerun hand-off.
vi.mock('@/features/collections/components/sidebarLazyDialogs', () => ({
  CollectionRunnerDialog: ({
    scope,
    initialConfig,
    onClose,
  }: {
    scope: { collectionId: string } | null;
    initialConfig?: unknown;
    onClose: () => void;
  }) =>
    scope ? (
      <div data-testid="runner">
        <span>runner for {scope.collectionId}</span>
        <pre data-testid="runner-config">{JSON.stringify(initialConfig)}</pre>
        <button type="button" onClick={onClose}>
          close runner
        </button>
      </div>
    ) : null,
}));

function collectionRun(over: Partial<CollectionRunResult> = {}): CollectionRunResult {
  return {
    id: 'cr1',
    collectionId: 'c1',
    collectionName: 'API',
    scopeName: 'Smoke',
    startedAt: Date.now(),
    durationMs: 120,
    iterations: 1,
    dataRows: 0,
    outcome: 'completed',
    requests: [
      {
        itemId: 'ok',
        itemName: 'Ok request',
        protocol: 'http',
        iteration: 0,
        status: 'success',
        httpStatus: 200,
        assertions: [],
      },
      {
        itemId: 'bad',
        itemName: 'Bad request',
        protocol: 'http',
        iteration: 0,
        status: 'failed',
        httpStatus: 500,
        assertions: [],
      },
    ],
    summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
    ...over,
  };
}

const loadRun: LoadTestRun = {
  id: 'lr1',
  method: 'POST',
  url: 'https://api.test/items',
  requestName: 'Create',
  request: {
    id: 'req',
    name: 'Create',
    type: 'http',
    method: 'POST',
    url: 'https://api.test/items',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
  stats: {
    count: 50,
    errors: 3,
    min: 1,
    max: 9,
    mean: 4,
    p50: 4.2,
    p90: 7,
    p95: 8.4,
    p99: 9,
    rps: 25,
  },
  rps: 25.4,
  completedAt: Date.now(),
};

describe('RunsPanel', () => {
  beforeEach(() => {
    platform.electron = true;
    platform.api = null;
    toast.success.mockReset();
    toast.error.mockReset();
    useMockStore.setState({ status: { running: false }, routes: [] });
    useLoadTestStore.setState({ runs: [] });
    useCollectionRunStore.setState({ runs: [] });
    useUiStore.setState({ loadTestOpen: false });
  });

  it('shows empty states and a desktop-only notice on web', () => {
    platform.electron = false;
    render(<RunsPanel />);
    expect(screen.getByText('Desktop-only feature.')).toBeTruthy();
    expect(screen.getByText(/Run a collection or folder from its context menu/)).toBeTruthy();
    expect(screen.getByText(/Run load/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('explains how to start the mock server on desktop when it is not running', () => {
    render(<RunsPanel />);
    expect(screen.getByText(/Not running\. Start one from a collection/)).toBeTruthy();
  });

  it('lists served routes and copies the base URL', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useMockStore.setState({
      status: { running: true, baseUrl: 'http://127.0.0.1:4010', port: 4010 },
      routes: [{ method: 'GET', path: '/users' }],
    });
    const { unmount } = render(<RunsPanel />);
    expect(screen.getByText('1 route')).toBeTruthy();
    expect(screen.getByText('/users')).toBeTruthy();
    fireEvent.click(screen.getByText('http://127.0.0.1:4010'));
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:4010');
    expect(toast.success).toHaveBeenCalledWith('Base URL copied');
    unmount();

    useMockStore.setState({
      status: { running: true, baseUrl: 'http://127.0.0.1:4010', port: 4010 },
      routes: [
        { method: 'GET', path: '/a' },
        { method: 'POST', path: '/b' },
      ],
    });
    render(<RunsPanel />);
    expect(screen.getByText('2 routes')).toBeTruthy();
  });

  it('does not copy when the running server has no base URL', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useMockStore.setState({ status: { running: true }, routes: [] });
    render(<RunsPanel />);
    expect(screen.getByText('0 routes')).toBeTruthy();
    const copyButton = screen.getAllByRole('button').find((b) => b.textContent === '');
    fireEvent.click(copyButton!);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('stops the mock server through the desktop API', async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, status: { running: false } });
    platform.api = { mock: { stop } };
    useMockStore.setState({
      status: { running: true, baseUrl: 'http://x', port: 1 },
      routes: [{ method: 'GET', path: '/a' }],
    });
    render(<RunsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mock server stopped'));
    expect(useMockStore.getState().status).toEqual({ running: false });
    expect(useMockStore.getState().routes).toEqual([]);
  });

  it('reports a failed stop and keeps the server state', async () => {
    const stop = vi.fn().mockResolvedValue({ ok: false, error: 'port busy' });
    platform.api = { mock: { stop } };
    useMockStore.setState({ status: { running: true, baseUrl: 'http://x', port: 1 }, routes: [] });
    render(<RunsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to stop mock server: port busy')
    );
    expect(useMockStore.getState().status.running).toBe(true);
  });

  it('stop is a no-op without the mock API', async () => {
    platform.api = {};
    useMockStore.setState({ status: { running: true, baseUrl: 'http://x', port: 1 }, routes: [] });
    render(<RunsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('summarises collection runs and opens the run detail', () => {
    useCollectionRunStore.setState({
      runs: [
        collectionRun(),
        collectionRun({
          id: 'cr2',
          scopeName: 'Green',
          summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
          requests: [],
        }),
      ],
    });
    render(<RunsPanel />);
    expect(screen.getByText('1 ✗')).toBeTruthy();
    expect(screen.getByText('1 skip')).toBeTruthy();
    expect(screen.getAllByText(/✗/)).toHaveLength(1);
    fireEvent.click(screen.getByTitle('Smoke'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Bad request')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('compares the opened run with another run of the same collection only', () => {
    useCollectionRunStore.setState({
      runs: [
        collectionRun(),
        collectionRun({ id: 'cr2', scopeName: 'Previous' }),
        collectionRun({ id: 'cr3', scopeName: 'Other collection', collectionId: 'c2' }),
      ],
    });
    render(<RunsPanel />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'cr1', 'cr2', 'cr3']);

    fireEvent.change(select, { target: { value: 'cr2' } });
    fireEvent.click(screen.getByTitle('Smoke'));
    expect(screen.getByText(/Comparing with Previous/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    // Comparing a run with itself is meaningless and is suppressed.
    fireEvent.change(select, { target: { value: 'cr1' } });
    fireEvent.click(screen.getByTitle('Smoke'));
    expect(screen.queryByText(/Comparing with/)).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    // A run from a different collection is not a valid comparison.
    fireEvent.change(select, { target: { value: 'cr3' } });
    fireEvent.click(screen.getByTitle('Smoke'));
    expect(screen.queryByText(/Comparing with/)).toBeNull();
  });

  it('hands a rerun of failed requests to the runner with the saved configuration', () => {
    useCollectionRunStore.setState({
      runs: [
        collectionRun({
          configuration: {
            runnableIds: ['ok', 'bad'],
            environmentId: 'env-1',
            iterations: 2,
            delayMs: 50,
            stopOnFailure: true,
            usedDataFile: false,
            retention: 'metadata',
          },
        }),
      ],
    });
    render(<RunsPanel />);
    fireEvent.click(screen.getByTitle('Smoke'));
    fireEvent.click(screen.getByRole('button', { name: /Rerun failed/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('runner for c1')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('runner-config').textContent ?? '')).toEqual({
      selectedIds: ['bad'],
      environmentId: 'env-1',
      iterations: 2,
      delayMs: 50,
      stopOnFailure: true,
      retention: 'metadata',
      usedDataFile: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'close runner' }));
    expect(screen.queryByTestId('runner')).toBeNull();
  });

  it('reruns a single request from a legacy run without configuration', () => {
    useCollectionRunStore.setState({ runs: [collectionRun()] });
    render(<RunsPanel />);
    fireEvent.click(screen.getByTitle('Smoke'));
    fireEvent.click(screen.getAllByRole('button', { name: /Run request/ })[0]!);
    expect(JSON.parse(screen.getByTestId('runner-config').textContent ?? '')).toEqual({
      selectedIds: ['ok'],
    });
  });

  it('clears collection runs after confirmation', () => {
    useCollectionRunStore.setState({ runs: [collectionRun()] });
    render(<RunsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Clear collection runs?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(useCollectionRunStore.getState().runs).toEqual([]);
  });

  it('renders load-test stats, reruns, and clears load runs after confirmation', () => {
    const openTab = vi.spyOn(useRequestStore.getState(), 'openTab');
    useLoadTestStore.setState({
      runs: [loadRun, { ...loadRun, id: 'lr2', stats: { ...loadRun.stats, errors: 0 } }],
    });
    render(<RunsPanel />);
    expect(screen.getAllByText('25 rps')).toHaveLength(2);
    expect(screen.getAllByText('p50 4')).toHaveLength(2);
    expect(screen.getAllByText('p95 8')).toHaveLength(2);
    expect(screen.getAllByText(/3 err/)).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Re-run load test' })[0]!);
    expect(openTab).toHaveBeenCalledWith(loadRun.request, { switchTo: true });
    expect(useUiStore.getState().loadTestOpen).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Clear load test runs?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useLoadTestStore.getState().runs).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear' }));
    expect(useLoadTestStore.getState().runs).toEqual([]);
    openTab.mockRestore();
  });
});
