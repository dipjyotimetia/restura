import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, GrpcRequest } from '@/types';
import { GrpcUnsupportedAuthNotice } from '../GrpcUnsupportedAuthNotice';

const request: GrpcRequest = {
  id: 'grpc-1',
  name: 'r',
  type: 'grpc',
  methodType: 'unary',
  url: 'https://grpc.example.com',
  service: 'svc.v1.Service',
  method: 'Call',
  metadata: [],
  message: '{}',
  auth: { type: 'none' },
};

afterEach(() => useCollectionStore.setState({ collections: [] }));

describe('GrpcUnsupportedAuthNotice (#900)', () => {
  it.each<[AuthConfig, RegExp]>([
    [
      {
        type: 'aws-signature',
        awsSignature: { accessKey: 'a', secretKey: 's', region: 'us-east-1', service: 'x' },
      },
      /AWS Signature/,
    ],
    [{ type: 'digest', digest: { username: 'u', password: 'p' } }, /Digest/],
    [{ type: 'wsse', wsse: { username: 'u', password: 'p' } } as AuthConfig, /WSSE/],
  ])('warns for %o', (auth, label) => {
    render(<GrpcUnsupportedAuthNotice request={{ ...request, auth }} />);
    const notice = screen.getByTestId('grpc-auth-unsupported-warning');
    expect(notice).toHaveTextContent(label);
    expect(notice).toHaveTextContent(/not supported for gRPC/);
  });

  it('renders nothing for supported auth', () => {
    const { container } = render(
      <GrpcUnsupportedAuthNotice
        request={{ ...request, auth: { type: 'bearer', bearer: { token: 't' } } }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('warns when the inherited folder auth is unsupported', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'Shop',
          items: [
            {
              id: 'f',
              name: 'AWS',
              type: 'folder',
              auth: {
                type: 'aws-signature',
                awsSignature: { accessKey: 'a', secretKey: 's', region: 'us-east-1', service: 'x' },
              },
              items: [{ id: 'grpc-1', name: 'r', type: 'request', request }],
            },
          ],
        },
      ],
    });
    render(<GrpcUnsupportedAuthNotice request={request} />);
    expect(screen.getByTestId('grpc-auth-unsupported-warning')).toHaveTextContent(
      /Inherited from AWS: AWS Signature/
    );
  });
});
