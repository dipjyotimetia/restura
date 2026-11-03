import { DEFAULT_MCP_SERVER_SETTINGS } from '@shared/mcp-server/settings';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ElectronAPI } from '../../../../../electron/types/electron-api';
import {
  enqueueApproval,
  enqueueSecretPrompt,
  useMcpServerRuntimeStore,
} from '../../store/useMcpServerRuntimeStore';

type ToolCallListener = (call: { callId: string; tool: string; input: unknown }) => void;

const h = vi.hoisted(() => ({
  onCall: undefined as ToolCallListener | undefined,
  onCancel: undefined as ((p: { callId: string }) => void) | undefined,
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () => ({ mcpControl: h.api }) as unknown as ElectronAPI,
  };
});

import { McpApprovalDialog } from '../McpApprovalDialog';
import { McpControlBridge } from '../McpControlBridge';
import { McpSecretPromptDialog } from '../McpSecretPromptDialog';

const RUNNING = { running: true, port: 4100, url: 'http://127.0.0.1:4100/mcp', inFlight: 0 };
const STOPPED = { running: false, inFlight: 0 };

beforeEach(() => {
  h.api = {
    start: vi.fn(async () => ({ ok: true, status: RUNNING, token: 't'.repeat(43) })),
    stop: vi.fn(async () => ({ ok: true, status: STOPPED })),
    status: vi.fn(async () => ({ ok: true, status: STOPPED })),
    sendToolResult: vi.fn(async () => ({ ok: true })),
    onToolCall: vi.fn((cb: ToolCallListener) => {
      h.onCall = cb;
      return () => {
        h.onCall = undefined;
      };
    }),
    onToolCancelled: vi.fn((cb: (p: { callId: string }) => void) => {
      h.onCancel = cb;
      return () => undefined;
    }),
  };
  useMcpServerRuntimeStore.setState({
    status: STOPPED,
    token: null,
    approvals: [],
    secretPrompts: [],
    activity: [],
  });
  useSettingsStore.getState().updateSettings({ mcpServer: DEFAULT_MCP_SERVER_SETTINGS });
});

describe('McpControlBridge', () => {
  it('does not start the server while the setting is off', async () => {
    render(<McpControlBridge />);
    await act(async () => {});
    expect(h.api.start).not.toHaveBeenCalled();
  });

  it('starts the server when enabled, and stops it when disabled', async () => {
    useSettingsStore.getState().updateSettings({
      mcpServer: { ...DEFAULT_MCP_SERVER_SETTINGS, enabled: true },
    });
    render(<McpControlBridge />);
    await waitFor(() => expect(h.api.start).toHaveBeenCalledOnce());
    expect(useMcpServerRuntimeStore.getState().status.running).toBe(true);

    act(() => {
      useSettingsStore.getState().updateSettings({ mcpServer: DEFAULT_MCP_SERVER_SETTINGS });
    });
    await waitFor(() => expect(h.api.stop).toHaveBeenCalledOnce());
  });

  it('adopts a server another window already runs instead of restarting it', async () => {
    h.api.status!.mockResolvedValue({ ok: true, status: RUNNING });
    useSettingsStore.getState().updateSettings({
      mcpServer: { ...DEFAULT_MCP_SERVER_SETTINGS, enabled: true },
    });
    render(<McpControlBridge />);
    await waitFor(() => expect(useMcpServerRuntimeStore.getState().status.running).toBe(true));
    expect(h.api.start).not.toHaveBeenCalled();
  });

  it('answers every forwarded tool call with the runtime result', async () => {
    render(<McpControlBridge />);
    await act(async () => {
      h.onCall?.({ callId: 'c-1', tool: 'describe_access', input: {} });
    });
    await waitFor(() =>
      expect(h.api.sendToolResult).toHaveBeenCalledWith({
        callId: 'c-1',
        // The setting is off, so the runtime refuses — but it still answers.
        result: { ok: false, error: 'The Restura MCP server is turned off.' },
      })
    );
  });
});

describe('McpApprovalDialog', () => {
  const card = {
    callId: 'a-1',
    tool: 'delete_item',
    tier: 'destructive' as const,
    title: 'Delete request “x”',
    details: ['From collection “Orders”'],
    client: 'claude-code',
    createdAt: 0,
  };

  it('focuses Deny, and Approve resolves approved', async () => {
    render(<McpApprovalDialog />);
    let decision: Promise<string> | undefined;
    act(() => {
      decision = enqueueApproval(card, 60_000);
    });
    expect(await screen.findByText('Delete request “x”')).toBeInTheDocument();
    expect(screen.getByText('From collection “Orders”')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(decision).resolves.toBe('approved');
    expect(screen.queryByText('Delete request “x”')).not.toBeInTheDocument();
  });

  it('Escape denies', async () => {
    render(<McpApprovalDialog />);
    let decision: Promise<string> | undefined;
    act(() => {
      decision = enqueueApproval({ ...card, callId: 'a-2' }, 60_000);
    });
    await screen.findByText('Delete request “x”');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await expect(decision).resolves.toBe('denied');
  });
});

describe('McpSecretPromptDialog', () => {
  it('returns the typed value, and declining returns null', async () => {
    render(<McpSecretPromptDialog />);
    let value: Promise<string | null> | undefined;
    act(() => {
      value = enqueueSecretPrompt(
        {
          callId: 's-1',
          environmentName: 'staging',
          key: 'apiToken',
          reason: 'call the API',
          createdAt: 0,
        },
        60_000
      );
    });
    const input = await screen.findByLabelText('Value for apiToken');
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'tok_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await expect(value).resolves.toBe('tok_123');

    act(() => {
      value = enqueueSecretPrompt(
        { callId: 's-2', environmentName: 'e', key: 'k', reason: 'r', createdAt: 0 },
        60_000
      );
    });
    // The previous value is never carried over.
    expect(await screen.findByLabelText('Value for k')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await expect(value).resolves.toBeNull();
  });
});
