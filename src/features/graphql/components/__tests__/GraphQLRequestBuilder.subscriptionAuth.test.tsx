/**
 * #878 / #882 — the builder's Subscribe path uses the effective handshake from
 * lib/subscriptionAuth (inherited auth, unapplied warnings) and the Auth tab
 * shows where subscription credentials go plus an UnappliedAuthNotice.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, Collection, HttpRequest } from '@/types';

const subMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@/features/graphql/lib/subscriptionClient', () => ({
  GraphQLSubscriptionClient: class {
    constructor(...args: unknown[]) {
      subMocks.ctor(...args);
    }
    connect(options: unknown) {
      subMocks.connect(options);
    }
    disconnect() {}
  },
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: vi.fn(), abort: vi.fn() }),
}));

vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));
vi.mock('../GraphQLBodyEditor', () => ({ default: () => null }));

const toastMocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMocks }));

import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import GraphQLRequestBuilder from '../GraphQLRequestBuilder';

function subscriptionRequest(auth: AuthConfig): HttpRequest {
  return {
    id: 'sub-req',
    name: 'Sub',
    type: 'http',
    method: 'POST',
    url: 'https://graphql.example/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: 'subscription Tick { tick }', graphqlVariables: '{}' },
    auth,
  };
}

function openTab(request: HttpRequest) {
  useRequestStore.setState({
    tabs: [{ id: 'tab-sub', request, isDirty: false }],
    activeTabId: 'tab-sub',
    isLoading: false,
  });
}

describe('GraphQLRequestBuilder — subscription auth', () => {
  beforeEach(() => {
    subMocks.ctor.mockReset();
    subMocks.connect.mockReset();
    toastMocks.warning.mockReset();
  });
  afterEach(() => useCollectionStore.setState({ collections: [] }));

  it('subscribes with collection-inherited auth', () => {
    const request = subscriptionRequest({ type: 'none' });
    useCollectionStore.setState({
      collections: [
        {
          id: 'col',
          name: 'C',
          items: [{ id: 'sub-req', name: 'Sub', type: 'request', request }],
          auth: { type: 'bearer', bearer: { token: 'inherited-token' } },
        } as unknown as Collection,
      ],
    });
    openTab(request);
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));

    const [url, headers, options] = subMocks.ctor.mock.calls[0] as [
      string,
      Record<string, string>,
      { connectionParams: Record<string, string> },
    ];
    expect(url).toBe('https://graphql.example/graphql');
    expect(headers.Authorization).toBe('Bearer inherited-token');
    expect(options.connectionParams.Authorization).toBe('Bearer inherited-token');
    expect(subMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://graphql.example/graphql' })
    );
    expect(toastMocks.warning).not.toHaveBeenCalled();
  });

  it('a Postman-guard-blocked subscription toasts the reason and never connects (#1232)', () => {
    const request = subscriptionRequest({ type: 'none' });
    useCollectionStore.setState({
      collections: [
        {
          id: 'col',
          name: 'C',
          items: [
            { id: 'sub-req', name: 'Sub', type: 'request', request, _postman: { noauth: true } },
          ],
          auth: { type: 'bearer', bearer: { token: 'inherited-token' } },
        } as unknown as Collection,
      ],
    });
    toastMocks.error.mockReset();
    openTab(request);
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));

    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringMatching(/^not sent: Postman auth is "No Auth"/)
    );
    expect(subMocks.ctor).not.toHaveBeenCalled();
    expect(subMocks.connect).not.toHaveBeenCalled();
  });

  it('warns (web) when keychain auth cannot be applied, and shows the notice', () => {
    openTab(
      subscriptionRequest({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h' } } })
    );
    render(<GraphQLRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringMatching(/desktop app/));
    const [, headers] = subMocks.ctor.mock.calls[0] as [string, Record<string, string>];
    expect(headers.Authorization).toBeUndefined();

    fireEvent.click(screen.getByRole('tab', { name: /Auth/ }));
    expect(screen.getByTestId('subscription-auth-notice')).toHaveTextContent(
      /connection_init payload/
    );
    expect(screen.getByTestId('subscription-unapplied-auth')).toHaveTextContent(/desktop app/);
    expect(screen.queryByTestId('subscription-keychain-handshake-only')).toBeNull();
  });

  it('desktop: passes keychain auth main-side and says it is not in connection_init', () => {
    (window as unknown as { electron?: unknown }).electron = { isElectron: true };
    try {
      const token = { kind: 'handle', id: 'h' } as const;
      openTab(subscriptionRequest({ type: 'bearer', bearer: { token } }));
      render(<GraphQLRequestBuilder />);

      fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
      expect(toastMocks.warning).not.toHaveBeenCalled();
      const [, headers, options] = subMocks.ctor.mock.calls[0] as [
        string,
        Record<string, string>,
        { mainSide?: unknown; connectionParams: Record<string, string> },
      ];
      expect(headers.Authorization).toBeUndefined();
      expect(options.connectionParams.Authorization).toBeUndefined();
      expect(options.mainSide).toEqual({ auth: { type: 'bearer', bearer: { token } } });

      fireEvent.click(screen.getByRole('tab', { name: /Auth/ }));
      expect(screen.getByTestId('subscription-keychain-handshake-only')).toHaveTextContent(
        /not included in the connection_init payload/
      );
      expect(screen.queryByTestId('subscription-unapplied-auth')).toBeNull();
    } finally {
      delete (window as unknown as { electron?: unknown }).electron;
    }
  });
});
