// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { loadMcpDispatchContext } from '../mcp-context-loader';
import { DEFAULT_CONSENT } from '../../../src/features/mcp-server/consent';

describe('loadMcpDispatchContext', () => {
  it('fails closed: returns empty state with default (hidden) consent', () => {
    const ctx = loadMcpDispatchContext();
    expect(ctx.collections).toEqual([]);
    expect(ctx.environments).toEqual([]);
    expect(ctx.history).toEqual([]);
    expect(ctx.consent).toBe(DEFAULT_CONSENT);
  });

  it('returns a fresh-readable context each call (no restart needed)', () => {
    expect(loadMcpDispatchContext()).not.toBe(loadMcpDispatchContext());
  });
});
