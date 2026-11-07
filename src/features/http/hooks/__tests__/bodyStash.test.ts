import { describe, expect, it } from 'vitest';
import { bodyStashSize, MAX_BODY_STASH_ENTRIES, stashCrossBinaryBody } from '../useHttpRequestPage';

describe('cross-binary body stash', () => {
  it('stays bounded so base64 bodies of old requests are not kept forever', () => {
    for (let i = 0; i < MAX_BODY_STASH_ENTRIES * 3; i++) stashCrossBinaryBody(`r${i}:binary`, 'x');
    expect(bodyStashSize()).toBe(MAX_BODY_STASH_ENTRIES);
  });
});
