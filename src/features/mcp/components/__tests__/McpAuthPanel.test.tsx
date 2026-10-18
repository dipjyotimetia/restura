import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAuthPanel } from '@/features/mcp/components/McpAuthPanel';
import { McpConnectionPanel } from '@/features/mcp/components/McpConnectionPanel';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, Collection } from '@/types';

function renderPanel(auth: AuthConfig, requestId = 'req-1') {
  const onChange = vi.fn();
  render(<McpAuthPanel requestId={requestId} auth={auth} onChange={onChange} />);
  return onChange;
}

describe('McpAuthPanel (#896)', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
  });
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  it('offers None / Bearer / API Key and switches type keeping only that block', () => {
    const onChange = renderPanel({ type: 'none' });
    expect(screen.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Bearer' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'bearer', bearer: { token: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'API Key' }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: '', in: 'header' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'none' });
  });

  it('edits a bearer token through the shared SecretInput', () => {
    const onChange = renderPanel({ type: 'bearer', bearer: { token: '' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'abc' } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: 'abc' } },
    });
    expect(screen.getByTestId('mcp-auth-storage-note')).toHaveTextContent(/re-enter/);
  });

  it('keeps API keys in a header (no query placement selector)', () => {
    const onChange = renderPanel({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: '', in: 'query' },
    });
    expect(screen.queryByLabelText('Add to')).toBeNull();
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'k' } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: { kind: 'inline', value: 'k' }, in: 'header' },
    });
  });

  it('mentions keychain storage on desktop', () => {
    (window as { electron?: unknown }).electron = { isElectron: true };
    renderPanel({ type: 'bearer', bearer: { token: '' } });
    expect(screen.getByTestId('mcp-auth-storage-note')).toHaveTextContent(/OS keychain/);
  });

  it('warns about an imported unsupported auth type and describes imported header auth', () => {
    renderPanel({ type: 'digest', digest: { username: 'u', password: 'p' } });
    expect(screen.getByTestId('mcp-auth-unsupported')).toHaveTextContent(/Digest/);
    expect(screen.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
  });

  it('describes imported header-shaped auth it does not edit', () => {
    renderPanel({ type: 'basic', basic: { username: 'u', password: 'p' } });
    expect(screen.getByTestId('mcp-auth-imported')).toHaveTextContent(/basic/);
  });

  it('shows the inherited-auth hint and flags an inherited scheme MCP cannot carry', () => {
    const collection = {
      id: 'c',
      name: 'Coll',
      auth: { type: 'aws-signature' },
      items: [
        {
          id: 'i',
          name: 'MCP',
          type: 'request',
          request: { id: 'req-1', type: 'mcp', auth: { type: 'none' } },
        },
      ],
    } as unknown as Collection;
    useCollectionStore.setState({ collections: [collection] });
    renderPanel({ type: 'none' });
    expect(screen.getByText(/Inherits/)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-auth-inherited-unsupported')).toHaveTextContent(/AWS Signature/);
  });
});

describe('McpConnectionPanel auth section', () => {
  const connection: McpConnection = {
    id: 'c1',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    headers: [],
    status: 'disconnected',
    capabilities: null,
    log: [],
    createdAt: 1,
  };

  it('expands the auth editor and labels the configured type', () => {
    const onAuthChange = vi.fn();
    render(
      <McpConnectionPanel
        connection={connection}
        showCatalog={false}
        onToggleCatalog={vi.fn()}
        onUrlChange={vi.fn()}
        onTransportChange={vi.fn()}
        onHeadersChange={vi.fn()}
        requestId="req-1"
        auth={{ type: 'bearer', bearer: { token: '' } }}
        onAuthChange={onAuthChange}
        onConnect={vi.fn(async () => {})}
        onDisconnect={vi.fn(async () => {})}
        onRefresh={vi.fn(async () => {})}
      />
    );
    const toggle = screen.getByRole('button', { name: /Auth/ });
    expect(toggle).toHaveTextContent('(bearer)');
    expect(screen.queryByTestId('mcp-auth-panel')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId('mcp-auth-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(onAuthChange).toHaveBeenCalledWith({ type: 'none' });
  });
});
