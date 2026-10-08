import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branches,
  featureGrid,
  featurePosition,
  features,
  findFeatures,
  highlights,
  labelWidth,
  layout,
  mapHeight,
  mapWidth,
  nodeSize,
  progress,
  treeParent,
} from '../src/data/product-tree';

describe('public product tree', () => {
  it('finds feature names before descriptions without matching HAR inside share', () => {
    expect(findFeatures('HAR').map((feature) => feature.id)).toEqual(['har-import']);
    expect(findFeatures('  CLIENT bidirectional  ')[0]?.id).toBe('grpc-streaming');
    expect(findFeatures('no-such-feature')).toEqual([]);
  });

  it('combines branch and status filters and preserves editorial order without a query', () => {
    expect(findFeatures('', 'shipped', 'security').map((feature) => feature.id)).toEqual([
      'auth',
      'local-storage',
      'secret-handles',
      'native-tls',
      'proxy-settings',
      'external-secrets',
    ]);
    expect(findFeatures('', 'planned', 'ai').map((feature) => feature.id)).toEqual([
      'ai-web',
      'agent-providers',
    ]);
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
    // validateResponse has no runtime consumer yet; only mock generation ships.
    expect(features.find((feature) => feature.id === 'contracts')?.status).toBe('in-progress');
  });

  it('gives every unshipped feature a plan, and shipped features none', () => {
    for (const feature of features) {
      if (feature.status === 'shipped') expect(feature.plan, feature.id).toBeUndefined();
      else {
        expect(feature.plan?.today, feature.id).toBeTruthy();
        expect(feature.plan?.milestones.length, feature.id).toBeGreaterThanOrEqual(3);
      }
      // Something in progress must have started, and must not be finished.
      if (feature.status === 'in-progress') {
        expect(progress(feature), feature.id).toBeGreaterThan(0);
        expect(progress(feature), feature.id).toBeLessThan(1);
      }
    }
  });

  it('lists highlights newest first with a cited pull request', () => {
    const dates = highlights.map((highlight) => highlight.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const highlight of highlights) expect(highlight.pr).toBeGreaterThan(0);
  });

  it('draws each feature under a same-branch parent, above and left of it', () => {
    for (const feature of features) {
      const parent = treeParent(feature);
      if (feature.parent) expect(parent?.id, feature.id).toBe(feature.parent);
      if (!parent) continue;
      expect(parent.branch, feature.id).toBe(feature.branch);
      const from = featurePosition(parent);
      const to = featurePosition(feature);
      expect(from.y, feature.id).toBeLessThan(to.y);
      expect(to.x - from.x, feature.id).toBe(layout.depthStep);
    }
  });

  it('places every feature once, inside the map, without overlapping another', () => {
    const boxes = features.map((feature) => {
      const { x, y } = featurePosition(feature);
      // Circle plus a two-line label beneath it.
      return {
        id: feature.id,
        left: x - labelWidth / 2,
        right: x + labelWidth / 2,
        top: y - nodeSize / 2,
        bottom: y + nodeSize / 2 + 40,
      };
    });
    for (const box of boxes) {
      expect(box.left, box.id).toBeGreaterThanOrEqual(0);
      expect(box.right, box.id).toBeLessThanOrEqual(mapWidth);
      expect(box.bottom, box.id).toBeLessThanOrEqual(mapHeight);
    }
    for (const [index, a] of boxes.entries())
      for (const b of boxes.slice(index + 1)) {
        const overlaps =
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    const rows = features.map(
      (feature) => `${featureGrid(feature).column}:${featureGrid(feature).row}`
    );
    expect(new Set(rows).size).toBe(features.length);
  });
});
