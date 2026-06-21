import { describe, it, expect } from 'vitest';
import { createProtocolRegistry } from '../registry';
import type { ProtocolModule } from '../types';

describe('ProtocolRegistry', () => {
  it('registers and looks up by id', () => {
    const reg = createProtocolRegistry();
    const fake: ProtocolModule = {
      id: 'fake',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({ id: 'r1', type: 'http', method: 'GET', url: '' }) as never,
      runRequest: async () => ({ status: 200, body: '', headers: {}, size: 0, time: 0 }) as never,
    };
    reg.register(fake);
    expect(reg.get('fake')).toBe(fake);
    expect(reg.list().map((p) => p.id)).toContain('fake');
  });

  it('throws on duplicate registration', () => {
    const reg = createProtocolRegistry();
    const fake: ProtocolModule = {
      id: 'x',
      label: 'X',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async () => ({}) as never,
    };
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/already registered/);
  });

  it('returns undefined for unknown id', () => {
    const reg = createProtocolRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('list() returns empty array on fresh registry', () => {
    const reg = createProtocolRegistry();
    expect(reg.list()).toEqual([]);
  });
});
