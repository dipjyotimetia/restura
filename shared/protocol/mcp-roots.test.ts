import { describe, expect, it } from 'vitest';
import { isLocalFileRootUri } from './mcp-roots';

describe('isLocalFileRootUri', () => {
  it.each(['file:///work/repo', 'file://localhost/work/repo', 'file:///C:/work'])(
    'accepts %s',
    (uri) => expect(isLocalFileRootUri(uri)).toBe(true)
  );

  it.each([
    '',
    'file:///',
    'file://fileserver/share',
    'file://user:pass@localhost/a',
    'file://user@localhost/a',
    'https://example.com/a',
    'not a uri',
  ])('rejects %s', (uri) => expect(isLocalFileRootUri(uri)).toBe(false));
});
