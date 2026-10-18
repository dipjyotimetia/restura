import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('McpAuthPanel OAuth 2.1 (#856)', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
  });
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  const flow: AuthConfig = {
    type: 'oauth2',
    oauth2: { accessToken: '', grantType: 'authorization_code' },
  };

  it('web: hides the OAuth option and explains a stored OAuth config is desktop-only', () => {
    renderPanel({ type: 'none' });
    expect(screen.queryByRole('radio', { name: 'OAuth 2.1' })).toBeNull();
    cleanup();
    renderPanel(flow);
    expect(screen.getByTestId('mcp-oauth-web')).toHaveTextContent(/desktop app/);
    expect(screen.queryByTestId('mcp-oauth-editor')).toBeNull();
  });

  it('desktop: offers OAuth 2.1, switching yields the sign-in flow config', () => {
    (window as { electron?: unknown }).electron = { isElectron: true, mcp: {} };
    const onChange = renderPanel({ type: 'bearer', bearer: { token: 'x' } });
    fireEvent.click(screen.getByRole('radio', { name: 'OAuth 2.1' }));
    expect(onChange).toHaveBeenLastCalledWith(flow);
  });

  it('desktop: edits client id / scope and shows a plaintext-free status with sign out', async () => {
    const oauthStatus = vi.fn(async () => ({
      signedIn: true,
      canRefresh: true,
      dynamicallyRegistered: true,
    }));
    const oauthSignOut = vi.fn(async () => ({ success: true }));
    (window as { electron?: unknown }).electron = {
      isElectron: true,
      mcp: { oauthStatus, oauthSignOut },
    };
    const onChange = vi.fn();
    render(
      <McpAuthPanel
        requestId="req-1"
        auth={flow}
        onChange={onChange}
        serverUrl="https://mcp.example.com/mcp"
      />
    );
    expect(await screen.findByText(/Signed in/)).toBeInTheDocument();
    expect(oauthStatus).toHaveBeenCalledWith({ url: 'https://mcp.example.com/mcp' });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'oauth2',
      oauth2: { accessToken: '', grantType: 'authorization_code', clientId: 'cid' },
    });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'mcp:read' } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'oauth2',
      oauth2: { accessToken: '', grantType: 'authorization_code', scope: 'mcp:read' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(oauthSignOut).toHaveBeenCalledWith({ url: 'https://mcp.example.com/mcp' })
    );
  });

  it('desktop: shows expiry, edits secret / redirect, and degrades when status fails', async () => {
    const oauthStatus = vi
      .fn()
      .mockResolvedValueOnce({
        signedIn: true,
        canRefresh: false,
        expiresAt: Date.UTC(2030, 0, 1),
        dynamicallyRegistered: false,
      })
      .mockRejectedValue(new Error('ipc down'));
    (window as { electron?: unknown }).electron = { isElectron: true, mcp: { oauthStatus } };
    const onChange = vi.fn();
    const auth: AuthConfig = { type: 'oauth2', oauth2: { ...flow.oauth2!, clientId: 'cid' } };
    const { rerender } = render(
      <McpAuthPanel
        requestId="r"
        auth={auth}
        onChange={onChange}
        serverUrl="https://a.example/mcp"
      />
    );
    expect(await screen.findByText(/token expires/)).toBeInTheDocument();
    expect(oauthStatus).toHaveBeenCalledWith({ url: 'https://a.example/mcp', clientId: 'cid' });
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'sec' } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'oauth2',
      oauth2: {
        accessToken: '',
        grantType: 'authorization_code',
        clientId: 'cid',
        clientSecret: { kind: 'inline', value: 'sec' },
      },
    });
    fireEvent.change(screen.getByLabelText('Redirect URI'), {
      target: { value: 'http://127.0.0.1:8765/cb' },
    });
    expect(onChange.mock.lastCall?.[0].oauth2.redirectUri).toBe('http://127.0.0.1:8765/cb');
    // A status failure (or a non-http URL) falls back to "not signed in".
    rerender(
      <McpAuthPanel
        requestId="r"
        auth={auth}
        onChange={onChange}
        serverUrl="https://b.example/mcp"
      />
    );
    expect(await screen.findByText(/Not signed in/)).toBeInTheDocument();
    rerender(<McpAuthPanel requestId="r" auth={auth} onChange={onChange} serverUrl="{{unset}}" />);
    expect(await screen.findByText(/Not signed in/)).toBeInTheDocument();
  });

  it('desktop: shows the client-secret field only for a static client id', () => {
    (window as { electron?: unknown }).electron = { isElectron: true, mcp: {} };
    renderPanel(flow);
    expect(screen.queryByLabelText(/Client secret/)).toBeNull();
    cleanup();
    renderPanel({ type: 'oauth2', oauth2: { ...flow.oauth2!, clientId: 'cid' } });
    expect(screen.getByLabelText(/Client secret/)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-oauth-status')).toHaveTextContent(/Not signed in/);
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
