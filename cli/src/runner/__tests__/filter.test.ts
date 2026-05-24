import { describe, it, expect } from 'vitest';
import { applyFilters } from '../filter';
import type { LoadedRequest } from '../collectionLoader';

function req(name: string, folderPath: string[] = []): LoadedRequest {
  return {
    relativePath: [...folderPath, name].join('/') || name,
    folderPath,
    type: 'http',
    request: {
      id: 'x',
      name,
      type: 'http',
      method: 'GET',
      url: '/',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    } as never,
  };
}

describe('applyFilters', () => {
  const items = [
    req('List users', ['users']),
    req('Create user', ['users']),
    req('Get billing', ['billing', 'invoices']),
    req('Health', []),
  ];

  it('returns everything when no filters are set', () => {
    expect(applyFilters(items, {})).toHaveLength(4);
  });

  it('filters to a single folder', () => {
    const out = applyFilters(items, { folder: 'users' });
    expect(out.map((r) => r.request.name)).toEqual(['List users', 'Create user']);
  });

  it('filters to a nested folder', () => {
    const out = applyFilters(items, { folder: 'billing/invoices' });
    expect(out.map((r) => r.request.name)).toEqual(['Get billing']);
  });

  it('include applies substring match by default', () => {
    const out = applyFilters(items, { include: ['user'] });
    // 'user' matches 'List users', 'Create user', and the folder segment 'users' in relativePath
    expect(out.map((r) => r.request.name).sort()).toEqual(['Create user', 'List users']);
  });

  it('include supports glob with *', () => {
    const out = applyFilters(items, { include: ['*Health*'] });
    expect(out.map((r) => r.request.name)).toEqual(['Health']);
  });

  it('exclude removes matching requests', () => {
    const out = applyFilters(items, { exclude: ['billing'] });
    expect(out.map((r) => r.request.name)).toEqual(['List users', 'Create user', 'Health']);
  });

  it('include + exclude compose', () => {
    const out = applyFilters(items, { include: ['user'], exclude: ['Create'] });
    expect(out.map((r) => r.request.name)).toEqual(['List users']);
  });
});
