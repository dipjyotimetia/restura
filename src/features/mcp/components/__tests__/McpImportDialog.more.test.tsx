import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false, scan: vi.fn() }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => platform.electron,
    getElectronAPI: () => (platform.electron ? { mcp: { importScan: platform.scan } } : null),
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));

import { McpImportDialog } from '@/features/mcp/components/McpImportDialog';
import { draftToMcpRequest } from '@/features/mcp/lib/mcpImport';
import { useCollectionStore } from '@/store/useCollectionStore';

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

beforeEach(() => {
  platform.electron = false;
  platform.scan.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  useCollectionStore.setState({ collections: [] });
});

describe('McpImportDialog more states', () => {
  it('imports several servers (plural message) and closes', async () => {
    render(<McpImportDialog />);
    openDialog();
    fireEvent.change(await screen.findByLabelText('MCP config JSON'), {
      target: {
        value:
          '{"mcpServers":{"a":{"url":"https://a.test/mcp"},"b":{"url":"https://b.test/sse","type":"sse"}}}',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 selected/ }));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringContaining('Imported 2 MCP servers')
      )
    );
    expect(useCollectionStore.getState().collections[0]?.items).toHaveLength(2);
    expect(screen.queryByLabelText('MCP config JSON')).toBeNull();
  });

  it('resets when closed with Escape', async () => {
    render(<McpImportDialog />);
    openDialog();
    fireEvent.change(await screen.findByLabelText('MCP config JSON'), {
      target: { value: '{"servers":{"a":{"url":"https://a.test"}}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByLabelText('Import a');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Import a')).toBeNull());
    openDialog();
    expect(await screen.findByLabelText('MCP config JSON')).toHaveProperty('value', '');
  });

  it('describes entries that are missing optional preview fields', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValue({
      sessionId: 's',
      sources: [
        {
          label: 'Selected file',
          location: '',
          formats: [],
          inputs: [],
          warnings: [],
          entries: [
            { key: '0.0', name: 'h', kind: 'http', disabled: false, warnings: [] },
            { key: '0.1', name: 's', kind: 'stdio', disabled: false, warnings: [], command: 'run' },
            { key: '0.2', name: 'i', kind: 'invalid', disabled: false, warnings: [] },
          ],
        },
      ],
    });
    render(<McpImportDialog />);
    openDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Detect installed apps/ }));
    expect(await screen.findByText('run')).toBeTruthy();
    expect(screen.getByText('Unsupported entry')).toBeTruthy();
    expect(screen.getByText(/http ·/)).toBeTruthy();
  });
});

describe('upload chooser', () => {
  it('ignores a cancelled chooser', async () => {
    render(<McpImportDialog />);
    openDialog();
    const input = await screen.findByLabelText('Upload MCP config');
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fireEvent.change(input);
    expect(screen.getByLabelText('MCP config JSON')).toBeTruthy();
  });
});

describe('draftToMcpRequest', () => {
  it('maps headers, working directory and plain + handle env rows', () => {
    const request = draftToMcpRequest({
      name: 'srv',
      transport: 'stdio',
      url: '',
      warnings: [],
      headers: [
        { key: 'Authorization', value: 'Bearer t', secret: true },
        { key: 'X-Team', value: 'core' },
      ],
      stdio: {
        command: 'npx',
        args: ['-y'],
        cwd: '/abs',
        env: [
          { key: 'LOG', value: 'debug' },
          { key: 'T_TOKEN', value: '', secret: true, secretRef: { kind: 'handle', id: 'h' } },
        ],
      },
    });
    expect(request.headers.map((h) => h.secret)).toEqual([true, undefined]);
    expect(request.stdio).toMatchObject({ cwd: '/abs' });
    expect(request.stdio?.env?.map((e) => e.secretRef)).toEqual([
      undefined,
      { kind: 'handle', id: 'h' },
    ]);
    expect(request.auth).toEqual({ type: 'none' });
  });
});
