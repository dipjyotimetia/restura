import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpRequest } from '@/types';
import { McpCodeDialog } from '../McpCodeDialog';
import { McpConnectionPanel } from '../McpConnectionPanel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const request = {
  id: 'r1',
  name: 'Docs MCP',
  type: 'mcp',
  url: 'https://mcp.example.test/mcp',
  transport: 'streamable-http',
  headers: [{ id: 'h1', key: 'X-Team', value: 'core', enabled: true }],
} as unknown as McpRequest;

describe('MCP code generation (O-6)', () => {
  it('renders a JSON-RPC cURL for the server URL and enabled headers', () => {
    render(<McpCodeDialog open onOpenChange={() => {}} request={request} />);
    const code = screen.getByText(/curl/);
    expect(code.textContent).toContain('https://mcp.example.test/mcp');
    expect(code.textContent).toContain('X-Team: core');
    expect(code.textContent).toContain('tools/list');
  });

  it('the connection panel shows a Code button only when onCode is wired', () => {
    const noop = vi.fn(async () => {});
    const onCode = vi.fn();
    render(
      <McpConnectionPanel
        connection={{
          id: 'c1',
          url: request.url,
          transport: 'streamable-http',
          headers: [],
          status: 'disconnected',
          capabilities: null,
          log: [],
          createdAt: 0,
        }}
        requestId="r1"
        auth={{ type: 'none' }}
        onAuthChange={vi.fn()}
        showCatalog={false}
        onToggleCatalog={vi.fn()}
        onUrlChange={vi.fn()}
        onTransportChange={vi.fn()}
        onHeadersChange={vi.fn()}
        onConnect={noop}
        onDisconnect={noop}
        onRefresh={noop}
        onCode={onCode}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^code$/i }));
    expect(onCode).toHaveBeenCalledOnce();
  });
});
