import { beforeEach, describe, expect, it, vi } from 'vitest';

const introspectSchema = vi.hoisted(() => vi.fn());
vi.mock('@/features/graphql/lib/introspection', () => ({ introspectSchema }));

import { useGraphQLSchemaStore } from '../useGraphQLSchemaStore';

const URL = 'https://api.example.com/graphql';
const ok = (n: number) => ({
  success: true,
  schema: { n },
  endpoint: URL,
  timestamp: Date.now(),
});

beforeEach(() => {
  introspectSchema.mockReset();
  useGraphQLSchemaStore.setState({ schemas: {}, loading: {} });
});

describe('useGraphQLSchemaStore.fetchSchema', () => {
  it('serves a fresh cached schema without re-introspecting', async () => {
    introspectSchema.mockResolvedValueOnce(ok(1));
    await useGraphQLSchemaStore.getState().fetchSchema(URL);
    await useGraphQLSchemaStore.getState().fetchSchema(URL);
    expect(introspectSchema).toHaveBeenCalledTimes(1);
  });

  it('force bypasses the TTL (explicit Refresh)', async () => {
    introspectSchema.mockResolvedValueOnce(ok(1)).mockResolvedValueOnce(ok(2));
    await useGraphQLSchemaStore.getState().fetchSchema(URL);
    const result = await useGraphQLSchemaStore.getState().fetchSchema(URL, { force: true });
    expect(introspectSchema).toHaveBeenCalledTimes(2);
    expect(result.schema).toEqual({ n: 2 });
    // `force` is a store option — it never reaches the introspection call.
    expect(introspectSchema.mock.calls[1]?.[1]).not.toHaveProperty('force');
  });

  it('force also retries a cached failure inside its 5-minute window', async () => {
    introspectSchema.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(ok(3));
    const failed = await useGraphQLSchemaStore.getState().fetchSchema(URL);
    expect(failed).toMatchObject({ success: false, error: 'boom' });
    expect((await useGraphQLSchemaStore.getState().fetchSchema(URL)).success).toBe(false);
    expect((await useGraphQLSchemaStore.getState().fetchSchema(URL, { force: true })).success).toBe(
      true
    );
  });
});
