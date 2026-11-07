import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import { McpConnectionPanel } from '../McpConnectionPanel';

function renderPanel(connection: Partial<McpConnection>) {
  const noop = vi.fn(async () => {});
  render(
    <McpConnectionPanel
      connection={{
        id: 'c1',
        url: 'https://mcp.example.test',
        transport: 'streamable-http',
        headers: [],
        status: 'connected',
        capabilities: null,
        log: [],
        createdAt: 0,
        ...connection,
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
    />
  );
}

describe('McpConnectionPanel negotiated protocol version (#862)', () => {
  it('shows the negotiated version while connected', () => {
    renderPanel({
      capabilities: { protocolVersion: '2025-11-25', tools: [], resources: [], prompts: [] },
    });
    expect(screen.getByTestId('mcp-protocol-version')).toHaveTextContent('v2025-11-25');
  });

  it('hides it when disconnected or unknown', () => {
    renderPanel({
      status: 'disconnected',
      capabilities: { protocolVersion: '2025-11-25', tools: [], resources: [], prompts: [] },
    });
    expect(screen.queryByTestId('mcp-protocol-version')).toBeNull();
  });
});

describe('McpConnectionPanel transport selector (M10)', () => {
  it('disables the transport radios while connected', () => {
    renderPanel({ status: 'connected' });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('enables them when disconnected and labels HTTP + SSE as legacy', () => {
    renderPanel({ status: 'disconnected' });
    expect(screen.getByRole('radio', { name: /Streamable HTTP/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /HTTP \+ SSE/ })).toHaveAttribute(
      'title',
      expect.stringMatching(/legacy/i)
    );
  });
});
