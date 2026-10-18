import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../mcpClient';
import { buildStdioLaunch, MCP_STDIO_WEB_ERROR } from '../mcpStdioLaunch';

const resolve = (text: string) => text.replace('{{root}}', '/srv/data');

describe('buildStdioLaunch', () => {
  it('resolves variables, drops blank argument lines and disabled env rows', () => {
    const launch = buildStdioLaunch(
      {
        command: '  npx ',
        args: ['-y', '', '  ', '@scope/server', '{{root}}'],
        cwd: '{{root}}',
        env: [
          { id: '1', key: 'LOG', value: '{{root}}', enabled: true },
          { id: '2', key: 'OFF', value: 'x', enabled: false },
          { id: '3', key: ' ', value: 'no-name', enabled: true },
          {
            id: '4',
            key: 'TOKEN',
            value: '',
            enabled: true,
            secretRef: { kind: 'handle', id: 'h-1' },
          },
        ],
      },
      resolve
    );
    expect(launch).toEqual({
      command: 'npx',
      args: ['-y', '@scope/server', '/srv/data'],
      cwd: '/srv/data',
      env: { LOG: '/srv/data', TOKEN: { kind: 'handle', id: 'h-1' } },
    });
  });

  it('handles a missing config and omits empty cwd/env', () => {
    expect(buildStdioLaunch(undefined, resolve)).toEqual({ command: '', args: [] });
  });
});

type Listener = (payload: unknown) => void;

function stubElectron(connectResult: { success: boolean; error?: string }) {
  const listeners = new Map<string, Listener>();
  const order: string[] = [];
  const mcp = {
    connect: vi.fn(async () => {
      order.push('connect');
      return connectResult;
    }),
    disconnect: vi.fn(async () => ({ success: true })),
    request: vi.fn(),
    on: vi.fn((channel: string, cb: Listener) => {
      order.push(`on:${channel}`);
      listeners.set(channel, cb);
    }),
    removeListener: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
  };
  (window as unknown as { electron: unknown }).electron = { isElectron: true, mcp };
  return { mcp, listeners, order };
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  vi.unstubAllGlobals();
});

function stdioClient(onStderr?: (text: string) => void, env?: Record<string, unknown>) {
  return new McpClient({
    url: '',
    transport: 'stdio',
    headers: {},
    connectionId: 'conn-1',
    stdio: {
      command: 'npx',
      args: ['-y', 'srv'],
      cwd: '/srv',
      ...(env ? { env: env as never } : {}),
    },
    ...(onStderr ? { onStderr } : {}),
  });
}

describe('McpClient stdio transport', () => {
  it('is refused on the web (no process spawning outside the desktop app)', async () => {
    const client = stdioClient();
    expect(await client.connect()).toEqual({ ok: false, error: MCP_STDIO_WEB_ERROR });
    const res = await client.request('tools/list');
    expect(res).toMatchObject({ ok: false, error: MCP_STDIO_WEB_ERROR });
  });

  it('subscribes to stderr before asking main to spawn, and forwards the launch', async () => {
    const { mcp, listeners, order } = stubElectron({ success: true });
    const lines: string[] = [];
    const client = stdioClient((t) => lines.push(t), {
      A: 'x',
      TOKEN: { kind: 'handle', id: 'h-1' },
    });
    expect(await client.connect()).toEqual({ ok: true });
    expect(order).toEqual(['on:mcp:stderr:conn-1', 'connect']);
    expect(mcp.connect).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'srv'],
      cwd: '/srv',
      env: { A: 'x', TOKEN: { kind: 'handle', id: 'h-1' } },
    });
    listeners.get('mcp:stderr:conn-1')?.({ text: 'hello\n' });
    listeners.get('mcp:stderr:conn-1')?.({ nope: 1 });
    expect(lines).toEqual(['hello\n']);

    await client.disconnect();
    expect(mcp.disconnect).toHaveBeenCalledWith({ connectionId: 'conn-1' });
    expect(mcp.removeListener).toHaveBeenCalledWith('mcp:stderr:conn-1', expect.any(Function));
  });

  it('removes the stderr listener when the launch fails or is denied', async () => {
    const { mcp } = stubElectron({ success: false, error: 'not approved' });
    const client = stdioClient(() => {});
    expect(await client.connect()).toEqual({ ok: false, error: 'not approved' });
    expect(mcp.removeListener).toHaveBeenCalledTimes(1);
  });

  it('rejects external vault secrets and an empty command before any IPC', async () => {
    const { mcp } = stubElectron({ success: true });
    const external = stdioClient(undefined, {
      K: { kind: 'external', provider: 'aws-secrets-manager', profileId: 'p', secretId: 's' },
    });
    expect(await external.connect()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/external vault/),
    });
    const empty = new McpClient({
      url: '',
      transport: 'stdio',
      headers: {},
      connectionId: 'conn-2',
      stdio: { command: '  ', args: [] },
    });
    expect(await empty.connect()).toEqual({ ok: false, error: 'A command is required for stdio' });
    expect(mcp.connect).not.toHaveBeenCalled();
  });

  it('omits empty env and cwd, and works without a stderr callback', async () => {
    const { mcp } = stubElectron({ success: true });
    const client = new McpClient({
      url: '',
      transport: 'stdio',
      headers: {},
      connectionId: 'conn-3',
      stdio: { command: 'srv', args: [] },
    });
    expect(await client.connect()).toEqual({ ok: true });
    expect(mcp.connect).toHaveBeenCalledWith({
      connectionId: 'conn-3',
      transport: 'stdio',
      command: 'srv',
      args: [],
    });
    expect(mcp.on).not.toHaveBeenCalled();
  });
});
