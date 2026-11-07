import { describe, expect, it } from 'vitest';
import { grpcBaseUrl, grpcMethodUrl } from './grpc-url';

describe('grpcBaseUrl / grpcMethodUrl', () => {
  it('drops query + fragment and trims trailing slashes', () => {
    expect(grpcBaseUrl('https://h.example.com/?env=stg#x')).toBe('https://h.example.com');
    expect(grpcBaseUrl('https://h.example.com/api//?env=stg')).toBe('https://h.example.com/api');
    expect(grpcBaseUrl('http://127.0.0.1:50051')).toBe('http://127.0.0.1:50051');
  });

  it('appends the service/method route after the path, never after the query', () => {
    expect(grpcMethodUrl('https://h.example.com/api/?env=stg#x', 'pkg.Svc', 'Call')).toBe(
      'https://h.example.com/api/pkg.Svc/Call'
    );
    expect(grpcMethodUrl('https://h.example.com', 'pkg.Svc', 'Call')).toBe(
      'https://h.example.com/pkg.Svc/Call'
    );
  });
});
