import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import type { McpRequest, McpServerCapabilities } from '@/types';

const CAPABILITIES: McpServerCapabilities = {
  tools: [
    {
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          filters: { type: 'object' },
        },
        required: ['query'],
      },
    },
  ],
  resources: [{ uri: 'file:///readme.md', name: 'Readme' }],
  prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
};

const client = vi.hoisted(() => ({
  options: [] as Array<{ url: string; transport: string; headers: Record<string, string> }>,
  callTool: vi.fn(),
}));

vi.mock('@/features/mcp/lib/mcpClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/mcp/lib/mcpClient')>();
  return {
    ...actual,
    McpClient: class {
      constructor(options: { url: string; transport: string; headers: Record<string, string> }) {
        client.options.push(options);
      }
      connect = vi.fn(() => Promise.resolve({ ok: true as const }));
      disconnect = vi.fn(() => Promise.resolve());
      discoverCapabilities = vi.fn(() => Promise.resolve(CAPABILITIES));
      callTool = client.callTool;
      readResource = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));
      getPrompt = vi.fn(() => Promise.resolve({ ok: true, result: {}, durationMs: 1 }));
    },
  };
});

vi.mock('@/features/mcp/components/McpConnectionPanel', () => ({
  McpConnectionPanel: ({
    connection,
    onConnect,
    onToggleCatalog,
    onUrlChange,
    onTransportChange,
    onHeadersChange,
  }: {
    connection: McpConnection;
    onConnect: () => Promise<void>;
    onToggleCatalog: () => void;
    onUrlChange: (value: string) => void;
    onTransportChange: (value: McpConnection['transport']) => void;
    onHeadersChange: (headers: McpConnection['headers']) => void;
  }) => (
    <div>
      <output aria-label="endpoint">{`${connection.transport} ${connection.url}`}</output>
      <input
        aria-label="MCP URL"
        value={connection.url}
        onChange={(e) => onUrlChange(e.target.value)}
      />
      <button type="button" onClick={() => onTransportChange('http-sse')}>
        Use HTTP+SSE
      </button>
      <button
        type="button"
        onClick={() =>
          onHeadersChange([{ id: 'h1', key: 'Authorization', value: '{{token}}', enabled: true }])
        }
      >
        Set auth header
      </button>
      <button type="button" onClick={() => void onConnect()}>
        Connect
      </button>
      <button type="button" onClick={onToggleCatalog}>
        Browse
      </button>
    </div>
  ),
}));

vi.mock('@/features/mcp/components/McpDiscoveryPanel', () => ({
  McpDiscoveryPanel: ({
    onToolSelect,
    onPromptSelect,
    onReadResource,
    onTabChange,
  }: {
    onToolSelect: (name: string) => void;
    onPromptSelect: (name: string) => void;
    onReadResource: (uri: string) => Promise<void>;
    onTabChange: (tab: 'tools' | 'resources' | 'prompts' | 'log') => void;
  }) => (
    <div>
      <button type="button" onClick={() => onToolSelect('search')}>
        Pick search
      </button>
      <button
        type="button"
        onClick={() => {
          onTabChange('prompts');
          onPromptSelect('greet');
        }}
      >
        Pick greet
      </button>
      <button type="button" onClick={() => void onReadResource('file:///readme.md')}>
        Read readme
      </button>
    </div>
  ),
}));

import { SaveToCollectionDialog } from '@/components/shared/SaveToCollectionDialog';
import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';

function savedRequest(): McpRequest {
  const item = useCollectionStore.getState().collections[0]?.items[0];
  if (!item || item.type !== 'request' || !item.request) throw new Error('nothing saved');
  return item.request as McpRequest;
}

async function saveActiveTab(user: ReturnType<typeof userEvent.setup>, tabId: string) {
  render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);
  await user.type(screen.getByPlaceholderText('New collection name'), 'MCP');
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

describe('McpRequestBuilder ↔ collections', () => {
  beforeEach(() => {
    client.options.length = 0;
    client.callTool.mockReset();
    client.callTool.mockResolvedValue({ ok: true, result: {}, durationMs: 1 });
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useCollectionStore.setState({ collections: [] });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('Save to Collection stores endpoint config plus the selected tool call and arguments', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().createNewRequest('mcp');
    render(<McpRequestBuilder />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'MCP URL' }), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    await user.click(screen.getByRole('button', { name: 'Use HTTP+SSE' }));
    await user.click(screen.getByRole('button', { name: 'Set auth header' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(Object.values(useMcpStore.getState().connections)[0]?.status).toBe('connected')
    );
    expect(client.options[0]).toMatchObject({
      url: 'https://mcp.example.com/mcp',
      transport: 'http-sse',
    });

    await user.click(screen.getByRole('button', { name: 'Browse' }));
    await user.click(screen.getByRole('button', { name: 'Pick search' }));
    fireEvent.change(screen.getByPlaceholderText('string'), { target: { value: 'restura' } });
    fireEvent.change(screen.getByPlaceholderText('number'), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'filters' }), {
      target: { value: '{"lang":"ts"}' },
    });

    await saveActiveTab(user, tabId);

    const saved = savedRequest();
    expect(saved).toMatchObject({
      type: 'mcp',
      url: 'https://mcp.example.com/mcp',
      transport: 'http-sse',
      headers: [{ key: 'Authorization', value: '{{token}}', enabled: true }],
      auth: { type: 'none' },
      defaultMethod: 'tools/call',
    });
    expect(JSON.parse(saved.defaultParams ?? '')).toEqual({
      name: 'search',
      arguments: { query: 'restura', limit: 5, filters: { lang: 'ts' } },
    });
  });

  it('persists prompts/get and resources/read selections as the single operation', async () => {
    const user = userEvent.setup();
    useRequestStore.getState().createNewRequest('mcp');
    useRequestStore.getState().updateRequest({ url: 'https://mcp.example.com/mcp' });
    render(<McpRequestBuilder />);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(Object.values(useMcpStore.getState().connections)[0]?.status).toBe('connected')
    );
    await user.click(screen.getByRole('button', { name: 'Browse' }));

    await user.click(screen.getByRole('button', { name: 'Pick greet' }));
    const promptArgument = screen.getAllByRole('textbox').at(-1)!;
    await user.type(promptArgument, 'Ada');
    let request = useRequestStore.getState().getActiveTab()?.request as McpRequest;
    expect(request.defaultMethod).toBe('prompts/get');
    expect(JSON.parse(request.defaultParams ?? '')).toEqual({
      name: 'greet',
      arguments: { who: 'Ada' },
    });

    await user.click(screen.getByRole('button', { name: 'Read readme' }));
    request = useRequestStore.getState().getActiveTab()?.request as McpRequest;
    expect(request.defaultMethod).toBe('resources/read');
    expect(JSON.parse(request.defaultParams ?? '')).toEqual({ uri: 'file:///readme.md' });
  });

  it('opening a saved MCP item restores the endpoint, tool selection and argument values', async () => {
    const user = userEvent.setup();
    const saved: McpRequest = {
      id: 'saved-mcp',
      name: 'Saved search',
      type: 'mcp',
      url: 'https://saved.example.com/mcp',
      transport: 'streamable-http',
      headers: [{ id: 'h', key: 'X-Key', value: 'k', enabled: true }],
      auth: { type: 'none' },
      defaultMethod: 'tools/call',
      defaultParams: JSON.stringify({ name: 'search', arguments: { query: 'saved', limit: 7 } }),
    };
    useRequestStore.getState().openTab(saved, { savedRequestId: 'item-1' });
    render(<McpRequestBuilder />);

    expect(await screen.findByRole('textbox', { name: 'MCP URL' })).toHaveValue(
      'https://saved.example.com/mcp'
    );
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByPlaceholderText('string')).toHaveValue('saved'));
    expect(screen.getByPlaceholderText('number')).toHaveValue('7');
    expect(client.options[0]).toMatchObject({
      url: 'https://saved.example.com/mcp',
      headers: { 'X-Key': 'k' },
    });

    await user.click(screen.getByRole('button', { name: 'Invoke' }));
    expect(client.callTool).toHaveBeenCalledWith(
      'search',
      { query: 'saved', limit: 7 },
      expect.any(AbortSignal)
    );
    // Restoring the saved operation is not an edit.
    expect(useRequestStore.getState().tabs[0]?.isDirty).toBe(false);
  });

  it('restoring saved args with schema-unknown keys and empty strings leaves the request untouched', async () => {
    const user = userEvent.setup();
    // `extra` is not in the tool schema (additionalProperties / CLI-authored);
    // `query` is a deliberately saved empty string.
    const defaultParams = JSON.stringify({
      name: 'search',
      arguments: { query: '', limit: 7, extra: { keep: true } },
    });
    const saved: McpRequest = {
      id: 'saved-mcp-extra',
      name: 'Saved search',
      type: 'mcp',
      url: 'https://saved.example.com/mcp',
      transport: 'streamable-http',
      headers: [],
      auth: { type: 'none' },
      defaultMethod: 'tools/call',
      defaultParams,
    };
    useRequestStore.getState().openTab(saved, { savedRequestId: 'item-2' });
    const before = useRequestStore.getState().tabs[0]?.request;
    render(<McpRequestBuilder />);

    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByPlaceholderText('number')).toHaveValue('7'));
    expect(screen.getByPlaceholderText('string')).toHaveValue('');

    const tab = useRequestStore.getState().tabs[0];
    expect(tab?.isDirty).toBe(false);
    expect(tab?.request).toBe(before);
    expect((tab?.request as McpRequest).defaultParams).toBe(defaultParams);

    // A real edit is merged onto the saved arguments: unknown keys and
    // untouched values (incl. the empty string) survive.
    fireEvent.change(screen.getByPlaceholderText('number'), { target: { value: '9' } });
    const edited = useRequestStore.getState().tabs[0];
    expect(edited?.isDirty).toBe(true);
    expect(JSON.parse((edited?.request as McpRequest).defaultParams ?? '')).toEqual({
      name: 'search',
      arguments: { query: '', limit: 9, extra: { keep: true } },
    });

    // Clearing an edited field removes it; everything else is still kept.
    fireEvent.change(screen.getByPlaceholderText('number'), { target: { value: '' } });
    expect(
      JSON.parse((useRequestStore.getState().tabs[0]?.request as McpRequest).defaultParams ?? '')
    ).toEqual({ name: 'search', arguments: { query: '', extra: { keep: true } } });
  });
});
