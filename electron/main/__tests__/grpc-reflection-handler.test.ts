// @vitest-environment node
import './setup';
import { describe, it, expect } from 'vitest';
import { parseTargetAddress } from '../handlers/grpc-reflection-handler';

describe('parseTargetAddress', () => {
  it('treats grpcs:// as TLS and defaults to port 443', () => {
    expect(parseTargetAddress('grpcs://api.example.com')).toEqual({
      address: 'api.example.com:443',
      useTls: true,
    });
  });

  it('treats https:// as TLS and defaults to port 443', () => {
    expect(parseTargetAddress('https://api.example.com')).toEqual({
      address: 'api.example.com:443',
      useTls: true,
    });
  });

  it('treats grpc:// as plaintext on port 80', () => {
    expect(parseTargetAddress('grpc://localhost')).toEqual({
      address: 'localhost:80',
      useTls: false,
    });
  });

  it('honours an explicit port for grpcs://', () => {
    expect(parseTargetAddress('grpcs://host:50051')).toEqual({
      address: 'host:50051',
      useTls: true,
    });
  });

  it('defaults a bare host:port (no scheme) to plaintext', () => {
    expect(parseTargetAddress('localhost:50051')).toEqual({
      address: 'localhost:50051',
      useTls: false,
    });
  });
});
