import { describe, it, expect } from 'vitest';
import {
  isSecretFieldName,
  redactSecretKeyValues,
  countSecretKeyValues,
} from '../keyvalue-secret-redaction';

describe('isSecretFieldName', () => {
  it('redacts credential names including camelCase (the casing the old regex missed)', () => {
    for (const name of [
      'Authorization',
      'X-API-Key',
      'apiKey',
      'accessToken',
      'access_token',
      'refreshToken',
      'sessionToken',
      'clientSecret',
      'secretKey',
      'x-goog-api-key',
      'privateKey',
      'jwt',
      'bearer',
      'password',
      'awsSignature',
      'Cookie',
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
  });

  it('does NOT redact pagination/structural or innocuous names', () => {
    for (const name of [
      'Accept',
      'Content-Type',
      'page_token',
      'next_token',
      'continuation_token',
      'pageToken',
      'sortKey',
      'primaryKey',
      'partitionKey',
      'idempotencyKey',
      'X-Author',
      'X-Request-Id',
      'traceparent',
      'monkey',
    ]) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });
});

describe('redactSecretKeyValues / countSecretKeyValues', () => {
  const rows = [
    { id: '1', key: 'accessToken', value: 'sk-leak', enabled: true },
    { id: '2', key: 'page_token', value: 'CAES-cursor', enabled: true },
    { id: '3', key: 'X-Custom', value: 'flagged', enabled: true, secret: true },
    { id: '4', key: 'Accept', value: 'application/json', enabled: true },
  ];

  it('blanks secret rows (camelCase + secret-flag) and keeps the rest', () => {
    const out = redactSecretKeyValues(rows)!;
    expect(out.find((r) => r.key === 'accessToken')!.value).toBe('');
    expect(out.find((r) => r.key === 'X-Custom')!.value).toBe('');
    expect(out.find((r) => r.key === 'page_token')!.value).toBe('CAES-cursor');
    expect(out.find((r) => r.key === 'Accept')!.value).toBe('application/json');
  });

  it('counts only the secret-bearing rows', () => {
    expect(countSecretKeyValues(rows)).toBe(2);
  });
});
