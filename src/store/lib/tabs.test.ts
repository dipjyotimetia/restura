import { describe, it, expect } from 'vitest';
import { createTabFromRequest, migrateLegacyStateToTabs, findTabIndex } from './tabs';
import type { HttpRequest, GrpcRequest } from '@/types';

const httpReq: HttpRequest = {
  id: 'req-1',
  name: 'Get user',
  type: 'http',
  method: 'GET',
  url: 'https://api.example.com/u/1',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const grpcReq: GrpcRequest = {
  id: 'req-2',
  name: 'Lookup',
  type: 'grpc',
  methodType: 'unary',
  url: 'grpc.example.com',
  service: 'svc.Foo',
  method: 'Bar',
  metadata: [],
  message: '',
  auth: { type: 'none' },
};

describe('createTabFromRequest', () => {
  it('creates a tab with a unique id and the given request', () => {
    const tab = createTabFromRequest(httpReq);
    expect(tab.id).toMatch(/^tab_/);
    expect(tab.request).toEqual(httpReq);
    expect(tab.isDirty).toBe(false);
    expect(tab.response).toBeUndefined();
  });

  it('marks the tab as not-dirty initially even if request has unsaved changes', () => {
    const tab = createTabFromRequest(httpReq);
    expect(tab.isDirty).toBe(false);
  });

  it('attaches savedRequestId when supplied', () => {
    const tab = createTabFromRequest(httpReq, { savedRequestId: 'saved-123' });
    expect(tab.savedRequestId).toBe('saved-123');
  });

  it('omits savedRequestId when not supplied', () => {
    const tab = createTabFromRequest(httpReq);
    expect(tab.savedRequestId).toBeUndefined();
  });
});

describe('findTabIndex', () => {
  it('returns the index of the tab with matching id', () => {
    const a = createTabFromRequest(httpReq);
    const b = createTabFromRequest(grpcReq);
    expect(findTabIndex([a, b], b.id)).toBe(1);
    expect(findTabIndex([a, b], a.id)).toBe(0);
  });
  it('returns -1 if no tab matches', () => {
    expect(findTabIndex([], 'nope')).toBe(-1);
  });
  it('returns -1 if id is null', () => {
    const a = createTabFromRequest(httpReq);
    expect(findTabIndex([a], null)).toBe(-1);
  });
});

describe('migrateLegacyStateToTabs', () => {
  it('seeds a single tab from legacy currentRequest when present', () => {
    const result = migrateLegacyStateToTabs({
      currentRequest: httpReq,
      httpRequest: httpReq,
      grpcRequest: grpcReq,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: null,
    });
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]?.request.id).toBe('req-1');
    expect(result.activeTabId).toBe(result.tabs[0]?.id);
  });

  it('attaches the legacy currentResponse to the seeded tab when types align', () => {
    const response = {
      id: 'res-1',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      size: 2,
      time: 50,
      timestamp: Date.now(),
    };
    const result = migrateLegacyStateToTabs({
      currentRequest: httpReq,
      httpRequest: httpReq,
      grpcRequest: null,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: response,
    });
    expect(result.tabs[0]?.response).toEqual(response);
  });

  it('does not attach response when requestId mismatches', () => {
    const response = {
      id: 'res-1',
      requestId: 'unrelated',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      size: 0,
      time: 0,
      timestamp: 0,
    };
    const result = migrateLegacyStateToTabs({
      currentRequest: httpReq,
      httpRequest: httpReq,
      grpcRequest: null,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: response,
    });
    expect(result.tabs[0]?.response).toBeUndefined();
  });

  it('returns empty tabs and null activeTabId when no legacy request exists', () => {
    const result = migrateLegacyStateToTabs({
      currentRequest: null,
      httpRequest: null,
      grpcRequest: null,
      sseRequest: null,
      mcpRequest: null,
      currentResponse: null,
    });
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });
});
