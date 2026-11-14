import { describe, expect, it } from 'vitest';
import { resolveResponsePaneState } from '../responsePaneState';

describe('resolveResponsePaneState', () => {
  it('returns loading while in-flight without a partial body', () => {
    expect(resolveResponsePaneState(true, null)).toEqual({ status: 'loading' });
    expect(resolveResponsePaneState(true, undefined)).toEqual({ status: 'loading' });
  });

  it('returns ready for a partial streaming response even while loading', () => {
    const response = { partial: true, body: 'chunk' };
    expect(resolveResponsePaneState(true, response)).toEqual({
      status: 'ready',
      response,
    });
  });

  it('returns empty when idle with no response', () => {
    expect(resolveResponsePaneState(false, null)).toEqual({ status: 'empty' });
  });

  it('returns ready with the response payload', () => {
    const response = { body: '{"ok":true}' };
    expect(resolveResponsePaneState(false, response)).toEqual({
      status: 'ready',
      response,
    });
  });
});
