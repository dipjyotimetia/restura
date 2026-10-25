import { describe, expect, it } from 'vitest';
import {
  grpcMetadataBytes,
  grpcMetadataSizeError,
  grpcUnsupportedAuthMessage,
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
