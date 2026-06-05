// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { interceptorRegistry } from '../interceptor-registry';

// Cast helpers — the registry's types reference http-handler's config/response
// shapes, but the registry treats them opaquely, so plain objects suffice.
const cfg = (over: Record<string, unknown> = {}) =>
  ({ method: 'GET', url: 'https://x', ...over }) as never;
const res = (over: Record<string, unknown> = {}) => ({ status: 200, ...over }) as never;

describe('interceptorRegistry', () => {
  afterEach(() => interceptorRegistry.clearInterceptors());

  it('runs request interceptors in registration order, threading the result', async () => {
    const order: string[] = [];
    interceptorRegistry.addRequestInterceptor((c) => {
      order.push('a');
      return { ...(c as object), tag: 'a' } as never;
    });
    interceptorRegistry.addRequestInterceptor((c) => {
      order.push('b');
      return { ...(c as object), tag: 'b' } as never;
    });

    const out = (await interceptorRegistry.runRequest(cfg())) as unknown as { tag: string };
    expect(order).toEqual(['a', 'b']);
    expect(out.tag).toBe('b'); // last interceptor wins on the threaded field
  });

  it('awaits async request interceptors', async () => {
    interceptorRegistry.addRequestInterceptor(async (c) => {
      await Promise.resolve();
      return { ...(c as object), async: true } as never;
    });
    const out = (await interceptorRegistry.runRequest(cfg())) as unknown as { async: boolean };
    expect(out.async).toBe(true);
  });

  it('runs response interceptors and passes the config through', async () => {
    const seenConfig = vi.fn();
    interceptorRegistry.addResponseInterceptor((r, c) => {
      seenConfig(c);
      return { ...(r as object), status: 201 } as never;
    });
    const out = (await interceptorRegistry.runResponse(res(), cfg({ url: 'https://y' }))) as {
      status: number;
    };
    expect(out.status).toBe(201);
    expect(seenConfig).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://y' }));
  });

  it('returns input unchanged when no interceptors are registered', async () => {
    const input = cfg({ url: 'https://passthrough' });
    expect(await interceptorRegistry.runRequest(input)).toBe(input);
  });

  it('clearInterceptors removes both request and response chains', async () => {
    const spy = vi.fn((c: unknown) => c as never);
    interceptorRegistry.addRequestInterceptor(spy);
    interceptorRegistry.addResponseInterceptor((r) => {
      spy(r);
      return r;
    });
    interceptorRegistry.clearInterceptors();

    await interceptorRegistry.runRequest(cfg());
    await interceptorRegistry.runResponse(res(), cfg());
    expect(spy).not.toHaveBeenCalled();
  });
});
