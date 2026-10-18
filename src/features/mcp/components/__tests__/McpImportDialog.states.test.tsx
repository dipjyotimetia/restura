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
import { useCollectionStore } from '@/store/useCollectionStore';

function fileWithText(name: string, text: string, size = text.length): File {
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'text', { value: async () => text });
  return file;
}

const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

const entry = (patch: Record<string, unknown>) => ({
  key: '0.0',
  name: 'srv',
  kind: 'http',
  disabled: false,
  warnings: [],
  url: 'https://x.test',
  transport: 'streamable-http',
  ...patch,
});
const source = (entries: unknown[], patch: Record<string, unknown> = {}) => ({
  label: 'Selected file',
  location: '~/mcp.json',
  formats: ['vscode'],
  inputs: [],
  warnings: ['Input "k" maps to {{k}}'],
  entries,
  ...patch,
});

beforeEach(() => {
  platform.electron = false;
  platform.scan.mockReset();
  platform.commit.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  useCollectionStore.setState({ collections: [] });
});

describe('McpImportDialog states', () => {
  it('web: rejects an oversize upload and previews a valid upload', async () => {
    render(<McpImportDialog />);
    openDialog();
    const input = await screen.findByLabelText('Upload MCP config');
    fireEvent.change(input, {
      target: { files: [fileWithText('big.json', '{}', 2 * 1024 * 1024)] },
    });
    expect(await screen.findByText(/larger than 1 MB/)).toBeTruthy();

    fireEvent.change(input, {
      target: {
        files: [fileWithText('mcp.json', '{"servers":{"a":{"url":"https://a.test/mcp"}}}')],
      },
    });
    expect(await screen.findByText('mcp.json')).toBeTruthy();
    expect(screen.getByText(/streamable-http · https:\/\/a.test\/mcp/)).toBeTruthy();
    fireEvent.change(input, { target: { files: [] } });
  });

  it('web: shows a parse error and Back returns to the paste view', async () => {
    render(<McpImportDialog />);
    openDialog();
    fireEvent.change(await screen.findByLabelText('MCP config JSON'), { target: { value: '{no' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toBe('File is not valid JSON');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('MCP config JSON')).toBeTruthy();
  });

  it('lets the user untick a server; invalid and disabled rows are not pre-selected', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValue({
      sessionId: 's',
      sources: [
        source([
          entry({ key: '0.0', name: 'good', warnings: ['careful'] }),
          entry({ key: '0.1', name: 'off', disabled: true }),
          entry({ key: '0.2', name: 'broken', kind: 'invalid', reason: 'bad entry' }),
        ]),
        source([], { label: 'Cursor', error: 'File is not valid JSON' }),
      ],
    });
    render(<McpImportDialog />);
    openDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Detect installed apps/ }));
    expect(await screen.findByText('careful')).toBeTruthy();
    expect(screen.getByText('bad entry')).toBeTruthy();
    expect(screen.getByText('disabled in source')).toBeTruthy();
    expect(screen.getByText('File is not valid JSON')).toBeTruthy();
    expect(screen.getByLabelText('Import off').getAttribute('data-state')).toBe('unchecked');
    expect(screen.getByLabelText('Import broken')).toHaveProperty('disabled', true);

    const good = screen.getByLabelText('Import good');
    fireEvent.click(good);
    expect(screen.getByRole('button', { name: /^Import\s*$/ })).toHaveProperty('disabled', true);
    fireEvent.click(good);
    expect(screen.getByRole('button', { name: /Import 1 selected/ })).toHaveProperty(
      'disabled',
      false
    );
  });

  it('desktop: nothing detected, scan failure and cancelled-picker handling', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValueOnce({ sessionId: null, sources: [] });
    render(<McpImportDialog />);
    openDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Detect installed apps/ }));
    expect(await screen.findByText('No MCP client configuration was found.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    platform.scan.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: /Choose file/ }));
    expect(await screen.findByText('Could not read MCP configuration.')).toBeTruthy();
  });

  it('desktop: reports skipped entries and commit failures', async () => {
    platform.electron = true;
    platform.scan.mockResolvedValue({ sessionId: 's', sources: [source([entry({})])] });
    platform.commit.mockResolvedValueOnce({
      drafts: [],
      skipped: [{ key: '0.0', name: '', reason: 'Not part of this scan' }],
    });
    render(<McpImportDialog />);
    openDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Choose file/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 selected/ }));
    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(expect.stringContaining('Skipped 1'))
    );
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    platform.commit.mockRejectedValueOnce(new Error('expired'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it('web: stdio rows stay unselectable and described by their command line', async () => {
    render(<McpImportDialog />);
    openDialog();
    fireEvent.change(await screen.findByLabelText('MCP config JSON'), {
      target: {
        value: '{"mcpServers":{"l":{"command":"npx","args":["-y","x"],"env":{"K_TOKEN":"s"}}}}',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('npx -y x')).toBeTruthy();
  });
});
