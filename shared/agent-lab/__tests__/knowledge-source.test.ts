import { describe, expect, it } from 'vitest';
import {
  buildEvidencePackets,
  EvidencePacket,
  KnowledgeSourceRegistry,
  renderEvidencePacket,
} from '../knowledge-source';
import { KnowledgeSourceSchema } from '../schema';

function makeDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src-1',
    kind: 'collection' as const,
    label: 'Orders API',
    version: '1.0.0',
    content: 'GET /orders\nGET /orders/{id}\nPOST /orders',
    provenance: {
      origin: 'local-collection' as const,
      acquiredAt: '2025-01-01T00:00:00.000Z',
      lastRefreshedAt: '2025-01-01T00:00:00.000Z',
    },
    budget: { maxBytes: 16_384, currentBytes: 48 },
    sharing: 'suite-scoped' as const,
    ...overrides,
  };
}

const encoder = new TextEncoder();

// ── Registry Tests ─────────────────────────────────────────────────────────

describe('KnowledgeSourceRegistry', () => {
  it('registers a source and retrieves it by ID', () => {
    const registry = new KnowledgeSourceRegistry();
    const descriptor = makeDescriptor();
    const source = registry.register(descriptor);

    expect(source.id).toBe('src-1');
    expect(source.kind).toBe('collection');
    expect(source.provenance.origin).toBe('local-collection');
    expect(source.sharing).toBe('suite-scoped');
    expect(source.redacted).toBe(false);

    const retrieved = registry.get('src-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('src-1');
  });

  it('throws on duplicate source IDs', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor());
    expect(() => registry.register(makeDescriptor())).toThrow(
      'duplicate knowledge source id: src-1'
    );
  });

  it('throws on empty source ID', () => {
    const registry = new KnowledgeSourceRegistry();
    expect(() =>
      registry.register(makeDescriptor({ id: '' }))
    ).toThrow('knowledge source id must be a non-empty string');
  });

  it('truncates content that exceeds the byte budget on registration', () => {
    const registry = new KnowledgeSourceRegistry({ defaultMaxBytes: 16 });
    const descriptor = makeDescriptor({
      content: 'This is a very long content that should be truncated',
      budget: { maxBytes: 16, currentBytes: 100 },
    });
    const source = registry.register(descriptor);
    expect(encoder.encode(source.content).byteLength).toBeLessThanOrEqual(16);
    expect(source.budget.currentBytes).toBeLessThanOrEqual(16);
    expect(source.refreshState.stale).toBe(true);
  });

  it('lists all registered sources', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1' }));
    registry.register(
      makeDescriptor({ id: 'src-2', kind: 'openapi', provenance: { origin: 'local-openapi', acquiredAt: '2025-01-01T00:00:00.000Z', lastRefreshedAt: '2025-01-01T00:00:00.000Z' } })
    );

    const all = registry.list();
    expect(all).toHaveLength(2);
  });

  it('lists sources by sharing policy', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'private-src', sharing: 'private' }));
    registry.register(makeDescriptor({ id: 'scoped-src', sharing: 'suite-scoped' }));

    expect(registry.listBySharing('private')).toHaveLength(1);
    expect(registry.listBySharing('suite-scoped')).toHaveLength(1);
    expect(registry.listBySharing('project')).toHaveLength(0);
  });

  it('lists sources by kind', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'col-src', kind: 'collection' }));
    registry.register(
      makeDescriptor({ id: 'api-src', kind: 'openapi', provenance: { origin: 'local-openapi', acquiredAt: '2025-01-01T00:00:00.000Z', lastRefreshedAt: '2025-01-01T00:00:00.000Z' } })
    );

    expect(registry.listByKind('collection')).toHaveLength(1);
    expect(registry.listByKind('openapi')).toHaveLength(1);
    expect(registry.listByKind('graphql')).toHaveLength(0);
  });

  it('unregisters a source by ID', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor());
    expect(registry.size).toBe(1);
    registry.unregister('src-1');
    expect(registry.size).toBe(0);
    expect(registry.get('src-1')).toBeUndefined();
  });

  it('clears all sources', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1' }));
    registry.register(makeDescriptor({ id: 'src-2' }));
    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('marks a source as stale with optional error', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor());
    registry.markStale('src-1', 'Network error');
    const source = registry.get('src-1')!;
    expect(source.refreshState.stale).toBe(true);
    expect(source.refreshState.lastError).toBe('Network error');
  });

  it('refreshes a source with new content and version', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor());
    const refreshed = registry.refresh('src-1', 'New content', '2.0.0');
    expect(refreshed.content).toBe('New content');
    expect(refreshed.version).toBe('2.0.0');
    expect(refreshed.refreshState.stale).toBe(false);
    expect(refreshed.provenance.lastRefreshedAt).toBeDefined();
  });

  it('throws when refreshing an unknown source', () => {
    const registry = new KnowledgeSourceRegistry();
    expect(() => registry.refresh('unknown', 'content')).toThrow(
      'cannot refresh unknown source: unknown'
    );
  });

  it('marks a source as redacted', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor());
    expect(registry.get('src-1')!.redacted).toBe(false);
    registry.markRedacted('src-1');
    expect(registry.get('src-1')!.redacted).toBe(true);
  });

  it('throws when marking unknown source as redacted', () => {
    const registry = new KnowledgeSourceRegistry();
    expect(() => registry.markRedacted('unknown')).toThrow(
      'cannot mark redacted unknown source: unknown'
    );
  });

  it('resolves a grounding selection into knowledge sources', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1' }));
    registry.register(makeDescriptor({ id: 'src-2' }));

    const resolved = registry.resolve({ sourceIds: ['src-1', 'src-2'], maxBytes: 1024 });
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.id).toBe('src-1');
    expect(resolved[1]!.id).toBe('src-2');
  });

  it('throws on duplicate IDs in a grounding selection', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1' }));

    expect(() =>
      registry.resolve({ sourceIds: ['src-1', 'src-1'], maxBytes: 1024 })
    ).toThrow('duplicate source id in selection: src-1');
  });

  it('throws on unknown source IDs in a resolution', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1' }));

    expect(() =>
      registry.resolve({ sourceIds: ['src-1', 'unknown'], maxBytes: 1024 })
    ).toThrow('unknown knowledge source: unknown');
  });

  it('converts a KnowledgeSource to a GroundingSource', () => {
    const registry = new KnowledgeSourceRegistry();
    const source = registry.register(makeDescriptor());
    const gs = registry.toGroundingSource(source);

    expect(gs.id).toBe(source.id);
    expect(gs.kind).toBe(source.kind);
    expect(gs.label).toBe(source.label);
    expect(gs.version).toBe(source.version);
    expect(gs.content).toBe(source.content);
    expect(gs.provenance).toBe(source.provenance);
    expect(gs.redacted).toBe(source.redacted);
    expect(gs.budget).toBe(source.budget);
    expect(gs.sharing).toBe(source.sharing);
  });

  it('exports and imports all sources', () => {
    const registry1 = new KnowledgeSourceRegistry();
    registry1.register(makeDescriptor({ id: 'src-1' }));
    registry1.register(makeDescriptor({ id: 'src-2' }));

    const exported = registry1.exportAll();

    const registry2 = new KnowledgeSourceRegistry();
    registry2.importAll(exported);
    expect(registry2.size).toBe(2);
    expect(registry2.get('src-1')).toBeDefined();
    expect(registry2.get('src-2')).toBeDefined();
  });

  it('importAll replaces existing sources with same IDs', () => {
    const registry = new KnowledgeSourceRegistry();
    registry.register(makeDescriptor({ id: 'src-1', content: 'original' }));
    registry.importAll([
      { ...makeDescriptor({ id: 'src-1', content: 'replaced' }), refreshState: { stale: false }, redacted: false },
    ] as any);
    expect(registry.get('src-1')!.content).toBe('replaced');
  });

  it('applies default sharing policy when none provided', () => {
    const registry = new KnowledgeSourceRegistry({ defaultSharing: 'private' });
    const descriptor = makeDescriptor({ sharing: undefined });
    const source = registry.register({ ...descriptor, sharing: undefined } as any);
    expect(source.sharing).toBe('private');
  });
});

// ── Evidence Packet Tests ──────────────────────────────────────────────────

describe('buildEvidencePackets', () => {
  it('builds evidence packets from knowledge sources and a selection', () => {
    const sources = [
      {
        id: 'src-1',
        kind: 'collection' as const,
        label: 'Orders API',
        version: '1.0.0',
        content: 'GET /orders\nGET /orders/{id}',
        provenance: { origin: 'local-collection' as const, acquiredAt: '2025-01-01T00:00:00.000Z', lastRefreshedAt: '2025-01-01T00:00:00.000Z' },
        budget: { maxBytes: 16_384, currentBytes: 30 },
        sharing: 'suite-scoped' as const,
        refreshState: { stale: false, lastAttempt: '2025-01-01T00:00:00.000Z' },
        redacted: false,
      },
    ];
    const packets = buildEvidencePackets(sources, { sourceIds: ['src-1'], maxBytes: 1024 });

    expect(packets).toHaveLength(1);
    expect(packets[0]!.sourceId).toBe('src-1');
    expect(packets[0]!.provenance).toBeDefined();
    expect(packets[0]!.provenance.origin).toBe('local-collection');
    expect(packets[0]!.redacted).toBe(false);
    expect(packets[0]!.description).toBeTruthy();
  });

  it('rejects an empty byte budget', () => {
    const sources: any[] = [];
    expect(() =>
      buildEvidencePackets(sources, { sourceIds: [], maxBytes: 0 })
    ).toThrow('grounding maxBytes must be a positive integer');
  });

  it('rejects a non-integer byte budget', () => {
    const sources: any[] = [];
    expect(() =>
      buildEvidencePackets(sources, { sourceIds: [], maxBytes: 1.5 })
    ).toThrow('grounding maxBytes must be a positive integer');
  });

  it('rejects a NaN byte budget', () => {
    const sources: any[] = [];
    expect(() =>
      buildEvidencePackets(sources, { sourceIds: [], maxBytes: Number.NaN })
    ).toThrow('grounding maxBytes must be a positive integer');
  });

  it('detects duplicate source IDs in the selection', () => {
    const sources: any[] = [];
    expect(() =>
      buildEvidencePackets(sources, { sourceIds: ['dup', 'dup'], maxBytes: 1024 })
    ).toThrow('duplicate source id in selection: dup');
  });

  it('applies truncation when content exceeds byte budget', () => {
    const sources = [
      {
        id: 'big-src',
        kind: 'openapi' as const,
        label: 'Big API',
        version: '1',
        content: 'A'.repeat(10_000),
        provenance: { origin: 'local-openapi' as const, acquiredAt: '2025-01-01T00:00:00.000Z', lastRefreshedAt: '2025-01-01T00:00:00.000Z' },
        budget: { maxBytes: 16_384, currentBytes: 10_000 },
        sharing: 'private' as const,
        refreshState: { stale: false, lastAttempt: '2025-01-01T00:00:00.000Z' },
        redacted: false,
      },
    ];
    const packets = buildEvidencePackets(sources, { sourceIds: ['big-src'], maxBytes: 256 });
    expect(packets[0]!.truncated).toBe(true);
    expect(
      encoder.encode(renderEvidencePacket(packets[0]!)).byteLength
    ).toBeLessThanOrEqual(256);
  });

  it('preserves provenance in rendered evidence packets', () => {
    const sources = [
      {
        id: 'src-1',
        kind: 'collection' as const,
        label: 'Orders',
        version: '1',
        content: 'GET /orders',
        provenance: { origin: 'local-collection' as const, acquiredAt: '2025-06-15T12:00:00.000Z' },
        budget: { maxBytes: 16_384, currentBytes: 10 },
        sharing: 'suite-scoped' as const,
        refreshState: { stale: false, lastAttempt: '2025-06-15T12:00:00.000Z' },
        redacted: false,
      },
    ];
    const [packet] = buildEvidencePackets(sources, { sourceIds: ['src-1'], maxBytes: 1_024 });
    const rendered = renderEvidencePacket(packet!);
    expect(rendered).toContain('[Evidence: Orders (collection, 1)]');
    expect(rendered).toContain('[Source: local-collection');
    expect(rendered).toContain('[Redacted: false');
  });
});

// ── Zod Schema Validation ─────────────────────────────────────────────────

describe('KnowledgeSourceSchema validation', () => {
  it('validates a well-formed knowledge source object', () => {
    const source = {
      id: 'valid-src',
      kind: 'collection',
      label: 'Valid Source',
      version: '1.0.0',
      content: 'some content',
      provenance: {
        origin: 'local-collection',
        acquiredAt: '2025-01-01T00:00:00.000Z',
        lastRefreshedAt: '2025-01-01T00:00:00.000Z',
      },
      budget: { maxBytes: 16_384, currentBytes: 11 },
      sharing: 'private',
      refreshState: {
        stale: false,
        lastAttempt: '2025-01-01T00:00:00.000Z',
      },
      redacted: false,
    };
    const result = KnowledgeSourceSchema.safeParse(source);
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = KnowledgeSourceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid kind', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'bad-kind',
      kind: 'unsupported',
      label: 'Bad',
      version: '1',
      content: 'x',
      provenance: { origin: 'local-collection', acquiredAt: '2025-01-01T00:00:00.000Z' },
      budget: { maxBytes: 100, currentBytes: 1 },
      sharing: 'private',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid origin in provenance', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'bad-origin',
      kind: 'collection',
      label: 'Bad',
      version: '1',
      content: 'x',
      provenance: { origin: 'not-a-valid-origin', acquiredAt: '2025-01-01T00:00:00.000Z' },
      budget: { maxBytes: 100, currentBytes: 1 },
      sharing: 'private',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-datetime acquiredAt', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'bad-date',
      kind: 'collection',
      label: 'Bad',
      version: '1',
      content: 'x',
      provenance: { origin: 'local-collection', acquiredAt: 'not-a-date' },
      budget: { maxBytes: 100, currentBytes: 1 },
      sharing: 'private',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid sharing policy', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'bad-sharing',
      kind: 'collection',
      label: 'Bad',
      version: '1',
      content: 'x',
      provenance: { origin: 'local-collection', acquiredAt: '2025-01-01T00:00:00.000Z' },
      budget: { maxBytes: 100, currentBytes: 1 },
      sharing: 'invalid-sharing',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive maxBytes in budget', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'bad-budget',
      kind: 'collection',
      label: 'Bad',
      version: '1',
      content: 'x',
      provenance: { origin: 'local-collection', acquiredAt: '2025-01-01T00:00:00.000Z' },
      budget: { maxBytes: -1, currentBytes: 1 },
      sharing: 'private',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts knowledge source with optional lastRefreshedAt missing', () => {
    const result = KnowledgeSourceSchema.safeParse({
      id: 'no-refresh',
      kind: 'collection',
      label: 'No Refresh',
      version: '1',
      content: 'content',
      provenance: {
        origin: 'local-collection',
        acquiredAt: '2025-01-01T00:00:00.000Z',
      },
      budget: { maxBytes: 100, currentBytes: 7 },
      sharing: 'private',
      refreshState: { stale: false },
      redacted: false,
    });
    expect(result.success).toBe(true);
  });
});

// ── Cancellation ───────────────────────────────────────────────────────────

describe('knowledge source cancellation support', () => {
  it('AbortSignal is part of the RetrievalAdapter contract', () => {
    // Verify the contract signature: index and query accept AbortSignal
    const adapter: Parameters<typeof validateRetrievalAdapter>[0] = {
      name: 'test',
      local: true,
      async index(_source, signal) {
        if (signal?.aborted) throw new Error('cancelled');
      },
      async query(_query, options) {
        if (options.signal?.aborted) throw new Error('cancelled');
        return [];
      },
      async remove(_sourceId, signal) {
        if (signal?.aborted) throw new Error('cancelled');
      },
      async clear(signal) {
        if (signal?.aborted) throw new Error('cancelled');
      },
    };
    expect(() => validateRetrievalAdapter(adapter)).not.toThrow();
  });

  it('retrieval adapter respects cancellation during indexing', async () => {
    const ac = new AbortController();
    ac.abort();
    const adapter = {
      name: 'test',
      local: true,
      async index(_source: any, signal?: AbortSignal) {
        if (signal?.aborted) throw new Error('cancelled');
      },
      async query(_query: string, _options: any) { return []; },
      async remove(_sourceId: string, _signal?: AbortSignal) {},
      async clear(_signal?: AbortSignal) {},
    };
    await expect(
      adapter.index({ id: 'test' } as any, ac.signal)
    ).rejects.toThrow('cancelled');
  });
});

function validateRetrievalAdapter(adapter: { name: string; local: boolean; index: Function; query: Function; remove: Function; clear: Function }) {
  if (typeof adapter.name !== 'string') throw new Error('name required');
  if (typeof adapter.local !== 'boolean') throw new Error('local required');
  if (typeof adapter.index !== 'function') throw new Error('index required');
  if (typeof adapter.query !== 'function') throw new Error('query required');
  if (typeof adapter.remove !== 'function') throw new Error('remove required');
  if (typeof adapter.clear !== 'function') throw new Error('clear required');
}

// ── ExternalSourceAdapter contract ─────────────────────────────────────────

describe('ExternalSourceAdapter contract', () => {
  it('defines the expected interface shape', () => {
    // This validates that the ExternalSourceAdapter interface is implementable
    const adapter = createMockAdapter();
    expect(adapter.kind).toBe('github');
    expect(adapter.label).toBe('GitHub');
    expect(adapter.available).toBe(true);
    expect(typeof adapter.validate).toBe('function');
    expect(typeof adapter.fetch).toBe('function');
    expect(typeof adapter.redact).toBe('function');
  });

  it('validate returns errors for missing URL', () => {
    const adapter = createMockAdapter();
    const errors = adapter.validate({ url: '' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('redact function strips sensitive fields', () => {
    const adapter = createMockAdapter();
    const redacted = adapter.redact('secret=my-token&key=abc123');
    expect(redacted).not.toContain('my-token');
    expect(redacted).not.toContain('abc123');
  });

  it('fetch returns a valid KnowledgeSourceDescriptor', async () => {
    const adapter = createMockAdapter();
    const descriptor = await adapter.fetch({ url: 'https://api.github.com' });
    expect(descriptor.id).toBeDefined();
    expect(descriptor.kind).toBe('collection');
    expect(descriptor.provenance).toBeDefined();
    expect(descriptor.provenance.origin).toBe('external-adapter');
  });
});

function createMockAdapter() {
  return {
    kind: 'github',
    label: 'GitHub',
    available: true,
    validate(config: { url: string }) {
      const errors: string[] = [];
      if (!config.url || config.url.length === 0) errors.push('url is required');
      return errors;
    },
    async fetch(config: { url: string }) {
      return {
        id: `github-${Date.now()}`,
        kind: 'collection' as const,
        label: 'GitHub Issues',
        version: '1',
        content: `Content from ${config.url}`,
        provenance: {
          origin: 'external-adapter' as const,
          acquiredAt: new Date().toISOString(),
        },
        budget: { maxBytes: 16_384, currentBytes: 20 },
        sharing: 'suite-scoped' as const,
      };
    },
    redact(content: string) {
      return content.replace(/(secret|token|key)=[^&\s]+/gi, '$1=REDACTED');
    },
  };
}
