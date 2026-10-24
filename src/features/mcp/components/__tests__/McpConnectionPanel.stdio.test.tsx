import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import type { McpStdioConfig, McpTransportType } from '@/types';

const platform = vi.hoisted(() => ({
  electron: false,
  revoke: vi.fn(async () => ({ success: true, revoked: 2 })),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => platform.electron,
    getElectronAPI: () =>
      platform.electron ? { mcp: { revokeStdioApprovals: platform.revoke } } : null,
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));

import {
  McpConnectionPanel,
  mcpTransportOptions,
} from '@/features/mcp/components/McpConnectionPanel';
import { argsToText, textToArgs } from '@/features/mcp/components/McpStdioFields';

function connection(patch: Partial<McpConnection> = {}): McpConnection {
  return {
    id: 'c1',
    url: '',
    transport: 'stdio',
    headers: [],
    status: 'disconnected',
    capabilities: null,
    log: [],
    createdAt: 0,
    ...patch,
  };
}

function renderPanel(
  conn: McpConnection,
  stdio: McpStdioConfig | undefined,
  overrides: Partial<Parameters<typeof McpConnectionPanel>[0]> = {}
) {
  const props = {
    connection: conn,
    showCatalog: false,
    onToggleCatalog: vi.fn(),
    onUrlChange: vi.fn(),
    onTransportChange: vi.fn<(t: McpTransportType) => void>(),
    onHeadersChange: vi.fn(),
    requestId: 'req-1',
    auth: { type: 'none' as const },
    onAuthChange: vi.fn(),
    stdio,
    onStdioChange: vi.fn<(s: McpStdioConfig) => void>(),
    onClearStderr: vi.fn(),
    onConnect: vi.fn(async () => {}),
    onDisconnect: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    ...overrides,
  };
  render(<McpConnectionPanel {...props} />);
  return props;
}

beforeEach(() => {
  platform.electron = false;
  platform.revoke.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

describe('MCP stdio transport UI', () => {
  it('offers stdio only on desktop', () => {
    expect(mcpTransportOptions(false).map((o) => o.value)).toEqual(['streamable-http', 'http-sse']);
    expect(mcpTransportOptions(true).map((o) => o.value)).toContain('stdio');

    renderPanel(connection({ transport: 'streamable-http' }), undefined);
    expect(screen.queryByRole('radio', { name: 'stdio' })).toBeNull();
  });

  it('on desktop: stdio is selectable and swaps the URL for a command field', () => {
    platform.electron = true;
    const props = renderPanel(connection({ transport: 'streamable-http' }), undefined);
    fireEvent.click(screen.getByRole('radio', { name: 'stdio' }));
    expect(props.onTransportChange).toHaveBeenCalledWith('stdio');
  });

  it('keeps the launch-settings toggle on its own row, apart from the wrapping action row', () => {
    platform.electron = true;
    renderPanel(connection(), { command: '', args: [] });
    const toggle = screen.getByRole('button', { name: /Launch settings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const actionRow = screen.getByRole('button', { name: 'Tools' }).parentElement as HTMLElement;
    expect(actionRow.className).toContain('flex-wrap');
    expect(actionRow.contains(toggle)).toBe(false);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('stdio arguments')).toBeInTheDocument();
  });

  it('enables Connect only once a command is set, and edits launch settings', () => {
    platform.electron = true;
    const props = renderPanel(connection(), { command: '', args: [] });
    expect(screen.getByRole('button', { name: /Connect/ })).toBeDisabled();
    expect(screen.queryByLabelText('MCP server URL')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    fireEvent.change(screen.getByLabelText('stdio arguments'), {
      target: { value: '-y\n@scope/server' },
    });
    expect(props.onStdioChange).toHaveBeenLastCalledWith({
      command: '',
      args: ['-y', '@scope/server'],
    });
    fireEvent.change(screen.getByLabelText('stdio working directory'), {
      target: { value: '/srv' },
    });
    expect(props.onStdioChange).toHaveBeenLastCalledWith({ command: '', args: [], cwd: '/srv' });
  });

  it('edits the command and environment rows', () => {
    platform.electron = true;
    const props = renderPanel(connection(), { command: '', args: [] });
    fireEvent.change(screen.getByLabelText('MCP stdio command'), { target: { value: 'npx' } });
    expect(props.onStdioChange).toHaveBeenLastCalledWith({ command: 'npx', args: [] });
    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add variable/ }));
    expect(props.onStdioChange).toHaveBeenLastCalledWith({
      command: '',
      args: [],
      env: [expect.objectContaining({ key: '', value: '', enabled: true })],
    });
  });

  it('clearing the working directory removes the field', () => {
    platform.electron = true;
    const props = renderPanel(connection(), { command: 'srv', args: [], cwd: '/srv' });
    expect(screen.getByRole('button', { name: /Connect/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    fireEvent.change(screen.getByLabelText('stdio working directory'), { target: { value: '' } });
    expect(props.onStdioChange).toHaveBeenLastCalledWith({ command: 'srv', args: [] });
  });

  it('lists secret-store backed env vars by name only', () => {
    platform.electron = true;
    renderPanel(connection(), {
      command: 'srv',
      args: [],
      env: [
        {
          id: 'e1',
          key: 'GITHUB_TOKEN',
          value: '',
          enabled: true,
          secretRef: { kind: 'handle', id: 'h-1' },
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    expect(screen.getByText(/From the secret store/)).toHaveTextContent('GITHUB_TOKEN');
  });

  it('"Forget approvals" asks main to revoke and reports the count', async () => {
    platform.electron = true;
    renderPanel(connection(), { command: 'srv', args: [] });
    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget approvals' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Forgot 2 saved approvals'));
    expect(platform.revoke).toHaveBeenCalledTimes(1);
  });

  it('reports a revoke failure', async () => {
    platform.electron = true;
    platform.revoke.mockRejectedValueOnce(new Error('x'));
    renderPanel(connection(), { command: 'srv', args: [] });
    fireEvent.click(screen.getByRole('button', { name: /Launch settings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget approvals' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it('explains on the web that stdio needs the desktop app, and cannot connect', () => {
    renderPanel(connection(), { command: 'srv', args: [] });
    expect(screen.getByRole('note')).toHaveTextContent(/only available in the desktop app/);
    expect(screen.getByRole('button', { name: /Connect/ })).toBeDisabled();
  });

  it('shows bounded server stderr with a clear action', () => {
    platform.electron = true;
    const props = renderPanel(connection({ stderr: 'boom: missing token\n' }), {
      command: 'srv',
      args: [],
    });
    expect(screen.getByLabelText('MCP server stderr')).toHaveTextContent('boom: missing token');
    fireEvent.click(screen.getByRole('button', { name: 'Clear server stderr' }));
    expect(props.onClearStderr).toHaveBeenCalled();
  });

  it('args round-trip one per line', () => {
    expect(textToArgs(argsToText(['a b', '--x=1']))).toEqual(['a b', '--x=1']);
    expect(textToArgs('a\r\nb')).toEqual(['a', 'b']);
  });
});
