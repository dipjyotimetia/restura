import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '@/types';
import { findRequestByReference, findRequestInItems, flattenRequests } from '../collectionHelpers';

function httpRequest(id: string, name: string, bodyType: HttpRequest['body']['type'] = 'none') {
  return {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://example.test',
    headers: [],
    params: [],
    body: { type: bodyType },
    auth: { type: 'none' },
  } as HttpRequest;
}

const items: CollectionItem[] = [
  { id: 'empty-folder', name: 'Empty', type: 'folder' },
  {
    id: 'users-folder',
    name: 'Users & teams',
    type: 'folder',
    items: [
      {
        id: 'http-item',
        name: 'Get user',
        type: 'request',
        request: httpRequest('http-1', 'Get user'),
      },
      {
        id: 'graphql-item',
        name: 'Lookup',
        type: 'request',
        request: httpRequest('graphql-1', 'Lookup', 'graphql'),
      },
      { id: 'missing-request', name: 'Broken', type: 'request' },
    ],
  },
  {
    id: 'mcp-item',
    name: 'Tool call',
    type: 'request',
    request: { id: 'mcp-1', name: 'Tool call', type: 'mcp' } as CollectionItem['request'],
  },
];

describe('workflow collection helpers', () => {
  it('finds saved requests by renderer id and portable encoded reference', () => {
    expect(findRequestInItems(items, 'graphql-1')).toMatchObject({ name: 'Lookup' });
    expect(findRequestInItems(items, 'missing')).toBeUndefined();
    expect(findRequestByReference(items, 'Users%20%26%20teams/Get%20user')).toMatchObject({
      id: 'http-1',
    });
    expect(findRequestByReference(items, 'Users%20%26%20teams/Missing')).toBeUndefined();
  });

  it('summarizes only executable saved requests with their workflow protocol and breadcrumbs', () => {
    expect(flattenRequests(items)).toEqual([
      {
        id: 'http-1',
        name: 'Get user',
        method: 'GET',
        kind: 'http',
        workflowProtocol: 'http',
        path: 'Users & teams / Get user',
      },
      {
        id: 'graphql-1',
        name: 'Lookup',
        method: 'GET',
        kind: 'http',
        workflowProtocol: 'graphql',
        path: 'Users & teams / Lookup',
      },
      {
        id: 'mcp-1',
        name: 'Tool call',
        method: 'MCP',
        kind: 'mcp',
        workflowProtocol: null,
        path: 'Tool call',
      },
    ]);
  });
});
