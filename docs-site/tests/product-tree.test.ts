import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branches, features, findFeatures } from '../src/data/product-tree';

describe('public product tree', () => {
  it('finds feature names before descriptions without matching HAR inside share', () => {
    expect(findFeatures('HAR').map((feature) => feature.id)).toEqual(['har-import']);
    expect(findFeatures('  CLIENT bidirectional  ')[0]?.id).toBe('grpc-streaming');
    expect(findFeatures('no-such-feature')).toEqual([]);
  });

  it('combines branch and status filters and preserves editorial order without a query', () => {
    expect(findFeatures('', 'planned', 'protocols')).toEqual([]);
    expect(findFeatures('', 'planned', 'ai').map((feature) => feature.id)).toEqual(['ai-web']);
    expect(findFeatures('')).toEqual(features);
  });
  it('has stable unique IDs and valid, acyclic prerequisites', () => {
    const ids = features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    const visit = (id: string, ancestors: string[] = []) => {
      expect(ancestors).not.toContain(id);
      const feature = features.find((item) => item.id === id);
      expect(feature, `Unknown prerequisite: ${id}`).toBeDefined();
      for (const dependency of feature?.prerequisites ?? []) visit(dependency, [...ancestors, id]);
    };
    for (const feature of features) {
      expect(feature.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(branches.some((branch) => branch.id === feature.branch)).toBe(true);
      visit(feature.id);
    }
  });

  it('links only to documentation pages that exist', () => {
    for (const feature of features) {
      if (!feature.href?.startsWith('/')) continue;
      const slug = feature.href.replace(/^\/|\/$/g, '');
      expect(existsSync(resolve('docs-site/src/content/docs', `${slug}.mdx`)), feature.href).toBe(
        true
      );
    }
  });

  it('corrects stale roadmap claims without promising unsupported web features', () => {
    for (const id of ['grpc-streaming', 'har-import', 'openapi-export', 'socket-io']) {
      expect(features.find((feature) => feature.id === id)?.status).toBe('shipped');
    }
    expect(features.find((feature) => feature.id === 'ai-assistant')?.platforms).toEqual([
      'Desktop',
    ]);
    expect(features.find((feature) => feature.id === 'grpc-streaming')?.platforms).toEqual([
      'Desktop',
    ]);
    expect(features.find((feature) => feature.id === 'ai-web')?.status).toBe('planned');
  });
});
