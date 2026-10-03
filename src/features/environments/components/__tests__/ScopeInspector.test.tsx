import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { ScopeInspector } from '../ScopeInspector';

const req: HttpRequest = {
  id: 'r',
  name: 'Get user',
  type: 'http',
  method: 'GET',
  url: 'https://x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

describe('ScopeInspector', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    useGlobalsStore.setState({ vars: { host: 'global.dev', only: 'g' } });
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'e',
          name: 'Dev',
          variables: [
            { id: '1', key: 'host', value: 'env.dev', enabled: true },
            { id: '2', key: 'token', value: 's3cret', enabled: true, secret: true },
          ],
        },
      ],
      activeEnvironmentId: 'e',
    });
  });

  it('lists each name once with its winning value and scope, masking secrets', () => {
    useRequestStore.getState().openTab(req);
    render(<ScopeInspector />);
    expect(screen.getByText('Get user')).toBeInTheDocument();

    const host = screen.getByText('host').closest('tr')!;
    expect(host).toHaveTextContent('env.dev');
    expect(host).not.toHaveTextContent('global.dev');

    const token = screen.getByText('token').closest('tr')!;
    expect(token).not.toHaveTextContent('s3cret');
    expect(token).toHaveTextContent('••••••');

    expect(screen.getByText('only').closest('tr')).toHaveTextContent('g');
  });

  it('labels script-set keys and handles an empty scope', () => {
    useRequestStore
      .getState()
      .openTab({ ...req, preRequestScript: "pm.environment.set('runtimeKey', '1')" });
    const { unmount } = render(<ScopeInspector />);
    expect(screen.getByText('runtimeKey').closest('tr')).toHaveTextContent(
      'set by a script at run time'
    );
    unmount();

    useGlobalsStore.setState({ vars: {} });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    render(<ScopeInspector />);
    expect(screen.getByText('No variables in scope')).toBeInTheDocument();
    expect(screen.getByText(/Open a request/)).toBeInTheDocument();
  });

  it('uses the connection scope for non-HTTP tabs and says so', () => {
    useRequestStore.getState().openTabWithMode('websocket');
    render(<ScopeInspector />);
    expect(
      screen.getByText(/resolves only the active environment and globals/)
    ).toBeInTheDocument();
    expect(screen.getByText('host').closest('tr')).toHaveTextContent('env.dev');
  });
});
