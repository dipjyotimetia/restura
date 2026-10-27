import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Collection, CollectionItem, HttpRequest } from '@/types';
import { InheritedAuthHint } from '../InheritedAuthHint';

const request: HttpRequest = {
  id: 'r1',
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

function seed(extra: Record<string, unknown>) {
  const collection: Collection = {
    id: 'c',
    name: 'Col',
    auth: { type: 'bearer', bearer: { token: 't' } },
    items: [{ id: 'i1', name: 'R', type: 'request', request, ...extra } as CollectionItem],
  };
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
}

describe('InheritedAuthHint (#1232)', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
  });

  it('shows the inherited auth for a plain inheriting request', () => {
    seed({});
    render(<InheritedAuthHint request={request} />);
    expect(screen.getByText(/Inherits/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the block reason instead of "Inherits" for a Postman noauth request', () => {
    seed({ _postman: { noauth: true } });
    render(<InheritedAuthHint request={request} />);
    expect(screen.getByRole('alert').textContent).toMatch(/^Not sent: Postman auth is "No Auth"/);
    expect(screen.queryByText(/Inherits/)).toBeNull();
  });

  it('renders nothing once the request has its own auth', () => {
    seed({ _postman: { noauth: true } });
    const { container } = render(
      <InheritedAuthHint
        request={{ ...request, auth: { type: 'basic', basic: { username: 'u', password: 'p' } } }}
      />
    );
    expect(container.textContent).toBe('');
  });
});
