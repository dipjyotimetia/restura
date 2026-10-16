import { describe, expect, it, vi } from 'vitest';
import { createIncrementalSend } from '../incrementalSend';

const snapshot = (hasNext: boolean, errors?: unknown[]) => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  result: { data: { a: 1 }, ...(errors ? { errors } : {}) },
  parts: 1,
  hasNext,
});

describe('createIncrementalSend', () => {
  it('has no stream hooks when the operation is not incremental', () => {
    const setResponse = vi.fn();
    const send = createIncrementalSend({
      enabled: false,
      requestId: 'r',
      startedAt: Date.now(),
      setResponse,
      publishErrors: vi.fn(),
    });
    expect(send.stream).toBeUndefined();
    send.stop(true);
    expect(setResponse).not.toHaveBeenCalled();
  });

  it('renders each snapshot, publishes its errors, and finalises the last one on stop', () => {
    const setResponse = vi.fn();
    const publishErrors = vi.fn();
    const send = createIncrementalSend({
      enabled: true,
      requestId: 'r',
      startedAt: Date.now(),
      setResponse,
      publishErrors,
    });
    send.stream?.onMessage?.(
      snapshot(true, [{ message: 'slow failed', locations: [{ line: 1, column: 3 }] }])
    );
    expect(setResponse.mock.calls[0]![0]).toMatchObject({ partial: true, requestId: 'r' });
    expect(publishErrors.mock.calls[0]![0]).toMatchObject([
      { message: 'slow failed', locations: [{ line: 1, column: 3 }] },
    ]);

    send.stop(true);
    expect(setResponse.mock.calls[1]![0]).toMatchObject({ partial: false });
    expect(setResponse.mock.calls[1]![0].bodyNotice).toMatch(/cancelled/);
    send.stop(false);
    expect(setResponse.mock.calls[2]![0].bodyNotice).toMatch(/failed/);
  });
});
