import { describe, expect, it } from 'vitest';
import {
  classifyMcpNotification,
  closeEntry,
  errorEntry,
  MAX_NOTIFICATION_DETAIL,
  MCP_SUBSCRIPTION_CLOSED_METHOD,
  truncateDetail,
} from '../mcpNotifications';

describe('classifyMcpNotification', () => {
  it.each([
    ['notifications/tools/list_changed', 'tools'],
    ['notifications/resources/list_changed', 'resources'],
    ['notifications/prompts/list_changed', 'prompts'],
  ] as const)('classifies %s as list_changed(%s)', (method, listKind) => {
    expect(classifyMcpNotification({ method, params: {} })).toEqual({
      kind: 'list_changed',
      method,
      listKind,
      summary: `${listKind} list changed`,
    });
  });

  it('classifies forwarded tool-call progress with its per-call key', () => {
    expect(
      classifyMcpNotification({
        method: 'notifications/progress',
        params: {
          progress: 2,
          total: 4,
          message: 'halfway',
          progressKey: 'tools/call#3',
          requestMethod: 'tools/call',
          name: 'slow',
        },
      })
    ).toEqual({
      kind: 'progress',
      method: 'notifications/progress',
      summary: 'slow: halfway',
      progress: { key: 'tools/call#3', value: 2, total: 4, message: 'halfway' },
    });
  });

  it('falls back to the progressToken and tolerates missing numbers', () => {
    const draft = classifyMcpNotification({
      method: 'notifications/progress',
      params: { progressToken: 7, progress: 'nope' },
    });
    expect(draft?.progress).toEqual({ key: '7', value: 0 });
    expect(draft?.summary).toBe('request');
    expect(
      classifyMcpNotification({ method: 'notifications/progress', params: {} })?.progress?.key
    ).toBe('notifications/progress');
    expect(
      classifyMcpNotification({
        method: 'notifications/progress',
        params: { requestMethod: 'prompts/get', progress: 1 },
      })?.summary
    ).toBe('prompts/get');
  });

  it('classifies logging messages with level, logger and structured data', () => {
    expect(
      classifyMcpNotification({
        method: 'notifications/message',
        params: { level: 'warning', logger: 'db', data: 'slow query' },
      })
    ).toEqual({
      kind: 'log',
      method: 'notifications/message',
      level: 'warning',
      summary: '[db] slow query',
    });
    const structured = classifyMcpNotification({
      method: 'notifications/message',
      params: { data: { rows: 3 } },
    });
    expect(structured).toMatchObject({
      level: 'info',
      summary: '{"rows":3}',
      detail: '{"rows":3}',
    });
    expect(classifyMcpNotification({ method: 'notifications/message', params: {} })?.summary).toBe(
      '(no data)'
    );
  });

  it('classifies resources/updated', () => {
    expect(
      classifyMcpNotification({
        method: 'notifications/resources/updated',
        params: { uri: 'file:///a.txt', _meta: { 'io.modelcontextprotocol/subscriptionId': 'x' } },
      })
    ).toEqual({
      kind: 'resource_updated',
      method: 'notifications/resources/updated',
      uri: 'file:///a.txt',
      summary: 'file:///a.txt updated',
    });
    expect(classifyMcpNotification({ method: 'notifications/resources/updated' })?.uri).toBe(
      '(unknown uri)'
    );
  });

  it('classifies server-ended subscription streams', () => {
    expect(
      classifyMcpNotification({
        method: MCP_SUBSCRIPTION_CLOSED_METHOD,
        params: { scope: 'resource', uri: 'a://1', reason: 'graceful' },
      })
    ).toMatchObject({
      kind: 'subscription_closed',
      uri: 'a://1',
      summary: 'Server ended the subscription to a://1 (graceful)',
    });
    expect(
      classifyMcpNotification({ method: MCP_SUBSCRIPTION_CLOSED_METHOD, params: {} })
    ).toMatchObject({ summary: 'Server ended the list-change stream (remote)' });
  });

  it('keeps unknown notifications with a detail but drops the _meta envelope', () => {
    expect(
      classifyMcpNotification({ method: 'notifications/custom', params: { a: 1, _meta: { x: 1 } } })
    ).toEqual({
      kind: 'other',
      method: 'notifications/custom',
      summary: 'notifications/custom',
      detail: '{"a":1}',
    });
    expect(classifyMcpNotification({ method: 'notifications/bare' })).toEqual({
      kind: 'other',
      method: 'notifications/bare',
      summary: 'notifications/bare',
    });
  });

  it('ignores payloads without a method', () => {
    expect(classifyMcpNotification(null)).toBeNull();
    expect(classifyMcpNotification('x')).toBeNull();
    expect(classifyMcpNotification({ params: {} })).toBeNull();
  });
});

describe('truncateDetail', () => {
  it('bounds large payloads', () => {
    const big = 'x'.repeat(MAX_NOTIFICATION_DETAIL + 50);
    const out = truncateDetail(big);
    expect(out?.startsWith('x'.repeat(MAX_NOTIFICATION_DETAIL))).toBe(true);
    expect(out).toContain('(50 more chars)');
  });

  it('handles undefined, empty objects and unserializable values', () => {
    expect(truncateDetail(undefined)).toBeUndefined();
    expect(truncateDetail({})).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(truncateDetail(cyclic)).toBe('[object Object]');
  });
});

describe('error/close entries', () => {
  it('builds error and close drafts', () => {
    expect(errorEntry('boom')).toEqual({ kind: 'error', method: 'mcp:error', summary: 'boom' });
    expect(closeEntry('stream ended')).toEqual({
      kind: 'close',
      method: 'mcp:close',
      summary: 'Connection closed: stream ended',
    });
  });
});
