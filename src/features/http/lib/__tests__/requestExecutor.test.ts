import { describe, it, expect } from 'vitest';
import { isStreamingAccept } from '../requestExecutor';

describe('isStreamingAccept', () => {
  it('detects text/event-stream', () => {
    expect(isStreamingAccept({ Accept: 'text/event-stream' })).toBe(true);
  });

  it('detects application/x-ndjson', () => {
    expect(isStreamingAccept({ Accept: 'application/x-ndjson' })).toBe(true);
  });

  it('detects application/jsonl', () => {
    expect(isStreamingAccept({ Accept: 'application/jsonl' })).toBe(true);
  });

  it('is case-insensitive on the value', () => {
    expect(isStreamingAccept({ Accept: 'TEXT/EVENT-STREAM' })).toBe(true);
    expect(isStreamingAccept({ Accept: 'Application/X-NDJson' })).toBe(true);
  });

  it('honours lowercase header keys', () => {
    expect(isStreamingAccept({ accept: 'application/x-ndjson' })).toBe(true);
  });

  it('matches when the streaming type is one element of a compound Accept', () => {
    expect(
      isStreamingAccept({ Accept: 'text/event-stream, application/json' })
    ).toBe(true);
    expect(
      isStreamingAccept({ Accept: 'application/json, application/x-ndjson' })
    ).toBe(true);
  });

  it('returns false for non-streaming Accept values', () => {
    expect(isStreamingAccept({ Accept: 'application/json' })).toBe(false);
    expect(isStreamingAccept({ Accept: 'text/html' })).toBe(false);
    expect(isStreamingAccept({ Accept: '*/*' })).toBe(false);
  });

  it('returns false when no Accept header is present', () => {
    expect(isStreamingAccept({})).toBe(false);
  });

  it('returns false for empty Accept header value', () => {
    expect(isStreamingAccept({ Accept: '' })).toBe(false);
  });

  it('does not match similarly-named non-streaming types', () => {
    // text/event-streamy isn't a real type; we use includes() so this DOES
    // technically match. Lock the current behaviour so a future tightening
    // is intentional.
    expect(isStreamingAccept({ Accept: 'text/event-stream-alt' })).toBe(true);
    // But "application/event-json" should not match any streaming type
    expect(isStreamingAccept({ Accept: 'application/event-json' })).toBe(false);
  });
});
