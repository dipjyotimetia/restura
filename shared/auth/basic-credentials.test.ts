import { describe, expect, it } from 'vitest';
import { encodeBasicCredentials } from './basic-credentials';

describe('encodeBasicCredentials', () => {
  it('encodes ASCII credentials', () => {
    expect(encodeBasicCredentials('user:pass')).toBe('dXNlcjpwYXNz');
  });

  it('encodes non-ASCII credentials as UTF-8 bytes', () => {
    expect(encodeBasicCredentials('jürgen:pw')).toBe('asO8cmdlbjpwdw==');
  });

  it('does not throw on characters outside Latin-1', () => {
    expect(encodeBasicCredentials('u:pä€ss')).toBe(
      Buffer.from('u:pä€ss', 'utf8').toString('base64')
    );
  });
});
