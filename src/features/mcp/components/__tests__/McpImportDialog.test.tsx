import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  electron: false,
  scan: vi.fn(),
  commit: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => platform.electron,
    getElectronAPI: () =>
      platform.electron
        ? { mcp: { importScan: platform.scan, importCommit: platform.commit } }
        : null,
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));

import { McpImportDialog } from '@/features/mcp/components/McpImportDialog';
import { draftToMcpRequest, scanPastedConfig, webDraftsFor } from '@/features/mcp/lib/mcpImport';
import { useCollectionStore } from '@/store/useCollectionStore';

const CONFIG = JSON.stringify({
  mcpServers: {
    remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer tok-123' } },
    local: { command: 'npx', args: ['-y', 'srv'], env: { API_KEY: 'plain-secret' } },
  },
});

beforeEach(() => {
  platform.electron = false;
  platform.scan.mockReset();
  platform.commit.mockReset();
  toastMock.success.mockReset();
  useCollectionStore.setState({ collections: [] });
});

describe('mcpImport lib (web path)', () => {
  it('previews both entries but only creates HTTP drafts', () => {
    const { source, entries } = scanPastedConfig(CONFIG, 'Pasted');
    expect(source.entries.map((e) => e.kind)).toEqual(['http', 'stdio']);
    // stdio env values are never hidden-by-handle on web, and not creatable
    expect(webDraftsFor(entries, ['0.0', '0.1']).map((d) => d.name)).toEqual(['remote']);
  });

  it('reports a parse error as a source error', () => {
    const { source } = scanPastedConfig('{nope', 'Pasted');
    expect(source.error).toBe('File is not valid JSON');
  });

  it('draftToMcpRequest keeps the secretRef handle and never a plaintext secret value', () => {
    const request = draftToMcpRequest({
      name: 'srv',
      transport: 'stdio',
      url: '',
      headers: [],
      warnings: [],
      stdio: {
        command: 'npx',
        args: [],
        env: [{ key: 'API_KEY', value: '', secret: true, secretRef: { kind: 'handle', id: 'h1' } }],
      },
    });
    expect(request.stdio?.env?.[0]).toMatchObject({
      value: '',
      secretRef: { kind: 'handle', id: 'h1' },
    });
  });
});

describe('McpImportDialog', () => {
  it('web: paste -> preview (stdio disabled, secret hidden) -> import creates an HTTP-only collection', async () => {
    render(<McpImportDialog />);
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    fireEvent.change(await screen.findByLabelText('MCP config JSON'), {
      target: { value: CONFIG },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('desktop app only')).toBeTruthy();
    expect(screen.getByLabelText('Import local')).toHaveProperty('disabled', true);
    expect(screen.queryByText(/tok-123/)).toBeNull();
    // nothing created before confirmation
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    await waitFor(() => expect(useCollectionStore.getState().collections).toHaveLength(1));
    const [collection] = useCollectionStore.getState().collections;
    expect(collection?.items).toHaveLength(1);
    const request = collection?.items[0]?.request;
    expect(request).toMatchObject({ type: 'mcp', url: 'https://mcp.example.com/mcp' });
    expect(request?.type === 'mcp' && request.headers[0]?.secret).toBe(true);
  });

  it('desktop: scan via main, commit by key, no secret value in the renderer', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValue({
      sessionId: 'sess-1',
      sources: [
        {
          label: 'Claude Desktop',
          location: '~/claude_desktop_config.json',
          formats: ['mcpServers'],
          inputs: [],
          warnings: [],
          entries: [
            {
              key: '0.0',
              name: 'local',
              kind: 'stdio',
              disabled: false,
              warnings: [],
              command: 'npx',
              args: ['-y', 'srv'],
              env: [{ name: 'API_KEY', secret: true }],
            },
          ],
        },
      ],
    });
    platform.commit.mockResolvedValue({
      skipped: [],
      drafts: [
        {
          name: 'local',
          transport: 'stdio',
          url: '',
          headers: [],
          warnings: [],
          stdio: {
            command: 'npx',
            args: ['-y', 'srv'],
            env: [
              {
                key: 'API_KEY',
                value: '',
                secret: true,
                secretRef: { kind: 'handle', id: 'h-1', label: 'MCP import: local API_KEY' },
              },
            ],
          },
        },
      ],
    });

    render(<McpImportDialog />);
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Detect installed apps/ }));
    expect(await screen.findByText(/Stored as protected secrets: API_KEY/)).toBeTruthy();
    expect(platform.scan).toHaveBeenCalledWith({ source: 'detect' });

    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    await waitFor(() =>
      expect(platform.commit).toHaveBeenCalledWith({ sessionId: 'sess-1', keys: ['0.0'] })
    );
    await waitFor(() => expect(useCollectionStore.getState().collections).toHaveLength(1));
    const request = useCollectionStore.getState().collections[0]?.items[0]?.request;
    expect(request?.type === 'mcp' && request.stdio?.env?.[0]?.secretRef).toMatchObject({
      kind: 'handle',
      id: 'h-1',
    });
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/ask for approval/));
  });

  it('desktop: a cancelled picker leaves the dialog on the start screen', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValue({ sessionId: null, sources: [] });
    render(<McpImportDialog />);
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Choose file/ }));
    await waitFor(() => expect(platform.scan).toHaveBeenCalledWith({ source: 'pick' }));
    expect(screen.getByRole('button', { name: /Detect installed apps/ })).toBeTruthy();
  });
});
