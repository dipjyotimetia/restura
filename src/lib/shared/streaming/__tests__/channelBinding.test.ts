import { describe, expect, it, vi } from 'vitest';
import { createChannelBinder } from '../channelBinding';
import { createFakeEventBridge } from './fakeEventBridge';

type Kind = 'open' | 'message' | 'close';
const channels = (id: string): Record<Kind, string> => ({
  open: `x:open:${id}`,
  message: `x:message:${id}`,
  close: `x:close:${id}`,
});

describe('createChannelBinder', () => {
  it('attaches only the handlers given', () => {
    const fake = createFakeEventBridge();
    const binder = createChannelBinder<Kind>({ bridge: () => fake.bridge, channels });
    const open = vi.fn();
    binder.bind('1', { open });
    fake.emit('x:open:1', 'p');
    expect(open).toHaveBeenCalledExactlyOnceWith('p');
    expect(fake.boundChannels()).toEqual(['x:open:1']);
  });

  it('does not double-bind when bound again for the same connection', () => {
    const fake = createFakeEventBridge();
    const binder = createChannelBinder<Kind>({ bridge: () => fake.bridge, channels });
    const first = vi.fn();
    const second = vi.fn();
    binder.bind('1', { message: first });
    binder.bind('1', { message: second });
    fake.emit('x:message:1', 'p');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('x:message:1')).toBe(1);
  });

  it('unbind removes every declared channel, including kinds never bound, for that id only', () => {
    const fake = createFakeEventBridge();
    const binder = createChannelBinder<Kind>({ bridge: () => fake.bridge, channels });
    binder.bind('1', { open: vi.fn() });
    binder.bind('2', { open: vi.fn() });
    fake.calls.length = 0;
    binder.unbind('1');
    expect(fake.calls).toEqual(['off:x:open:1', 'off:x:message:1', 'off:x:close:1']);
    expect(fake.boundChannels()).toEqual(['x:open:2']);
  });

  it('drains before detaching, on unbind and on rebind', () => {
    const fake = createFakeEventBridge();
    const order: string[] = [];
    const drain = vi.fn((id: string) => {
      // Listeners must still be attached while the drain runs.
      order.push(`drain:${id}:${fake.listenerCount(`x:open:${id}`)}`);
    });
    const binder = createChannelBinder<Kind>({ bridge: () => fake.bridge, channels, drain });
    binder.bind('1', { open: vi.fn() });
    order.length = 0;
    binder.unbind('1');
    expect(order).toEqual(['drain:1:1']);
    binder.bind('1', { open: vi.fn() });
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('drains even when the bridge is unavailable, and binds nothing', () => {
    const drain = vi.fn();
    const binder = createChannelBinder<Kind>({ bridge: () => undefined, channels, drain });
    expect(() => binder.bind('1', { open: vi.fn() })).not.toThrow();
    expect(drain).toHaveBeenCalledWith('1');
  });
});
