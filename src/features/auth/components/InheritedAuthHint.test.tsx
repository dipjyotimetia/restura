import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { HttpRequest } from '@/types';
import { authTypeLabel, InheritedAuthHint } from './InheritedAuthHint';

const request: HttpRequest = {
  id: 'req-1',
  name: 'r',
  type: 'http',
  method: 'GET',
  url: 'https://x.dev',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

afterEach(() => useCollectionStore.setState({ collections: [] }));

describe('InheritedAuthHint', () => {
  it('names the inherited auth and its source', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'Shop',
          items: [
            {
              id: 'f',
              name: 'Admin',
              type: 'folder',
              auth: { type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'header' } },
              items: [{ id: 'req-1', name: 'r', type: 'request', request }],
            },
          ],
        },
      ],
    });
    render(<InheritedAuthHint request={request} />);
    expect(screen.getByText(/Inherits/)).toHaveTextContent('Inherits API Key auth from “Admin”');
  });

  it('renders nothing when the request has its own auth or nothing to inherit', () => {
    const { container } = render(
      <InheritedAuthHint
        request={{ ...request, auth: { type: 'bearer', bearer: { token: 't' } } }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<InheritedAuthHint request={request} />);
    expect(none).toBeEmptyDOMElement();
  });

  it('labels auth types, falling back to the raw type', () => {
    expect(authTypeLabel('aws-signature')).toBe('AWS Signature');
    expect(authTypeLabel('none')).toBe('none');
  });
});
