import { describe, expect, it } from 'vitest';
import { isValidGrpcMethodName, isValidGrpcServiceName } from '../grpc-names';
import {
  grpcMetadataBytes,
  grpcMetadataSizeError,
  grpcUnsupportedAuthMessage,
  isBase64MetadataValue,
  normalizeBinaryMetadata,
} from '../grpc-request-policy';
import { MAX_GRPC_METADATA_BYTES } from '../header-policy';

describe('grpcUnsupportedAuthMessage (#900)', () => {
  it.each(['aws-signature', 'oauth1', 'wsse', 'digest', 'ntlm'])('blocks %s', (type) => {
    expect(grpcUnsupportedAuthMessage({ type })).toMatch(/not supported for gRPC/);
  });

  it.each(['none', 'basic', 'bearer', 'api-key', 'oauth2'])('allows %s', (type) => {
    expect(grpcUnsupportedAuthMessage({ type })).toBeNull();
  });

  it('ignores prototype keys and missing auth', () => {
    expect(grpcUnsupportedAuthMessage({ type: 'toString' })).toBeNull();
    expect(grpcUnsupportedAuthMessage(undefined)).toBeNull();
  });
});

describe('grpcMetadataSizeError (#895)', () => {
  it('measures keys + values in UTF-8 bytes', () => {
    expect(grpcMetadataBytes({ ab: 'é' })).toBe(4);
  });

  it('allows exactly the cap and rejects one byte over', () => {
    const atCap = { k: 'a'.repeat(MAX_GRPC_METADATA_BYTES - 1) };
    expect(grpcMetadataSizeError(atCap)).toBeNull();
    const over = { k: 'a'.repeat(MAX_GRPC_METADATA_BYTES) };
    expect(grpcMetadataSizeError(over)).toBe(
      `Total metadata size (${MAX_GRPC_METADATA_BYTES + 1} bytes) exceeds maximum of ${MAX_GRPC_METADATA_BYTES} bytes`
    );
  });
});

describe('binary metadata (-bin keys)', () => {
  it.each(['aGVsbG8=', 'aGVsbG8', 'AAEC', '_-8', ''])('treats %j as already base64', (v) => {
    expect(isBase64MetadataValue(v)).toBe(true);
  });

  it.each(['hello world', 'a', 'abcde', 'x=y', 'ü'])('treats %j as text', (v) => {
    expect(isBase64MetadataValue(v)).toBe(false);
  });

  it('encodes non-base64 -bin values as UTF-8 base64 and leaves others alone', () => {
    const out = normalizeBinaryMetadata({
      'trace-bin': 'hello world',
      'Raw-Bin': 'AAEC',
      'x-plain': 'hello world',
    });
    expect(out).toEqual({
      'trace-bin': btoa('hello world'),
      'Raw-Bin': 'AAEC',
      'x-plain': 'hello world',
    });
  });

  it('returns the same object when nothing needs encoding', () => {
    const md = { 'a-bin': 'AAEC', b: 'c' };
    expect(normalizeBinaryMetadata(md)).toBe(md);
  });
});

describe('gRPC identifier rules', () => {
  it.each([
    'helloworld.Greeter',
    'Greeter',
    'Company.Orders.OrderService',
    'acme.v1.Order_Service',
    '_internal.Svc',
  ])('accepts service %s', (name) => {
    expect(isValidGrpcServiceName(name)).toBe(true);
  });

  it.each(['', '.Svc', 'a..B', 'a/B', 'a.B.', '1pkg.Svc', 'a.B/../C', 'a B'])(
    'rejects service %j',
    (name) => {
      expect(isValidGrpcServiceName(name)).toBe(false);
    }
  );

  it.each(['SayHello', 'sayHello', 'Get_Item', '_x'])('accepts method %s', (name) => {
    expect(isValidGrpcMethodName(name)).toBe(true);
  });

  it.each(['', 'a.b', 'a/b', '9x', 'a-b'])('rejects method %j', (name) => {
    expect(isValidGrpcMethodName(name)).toBe(false);
  });
});
