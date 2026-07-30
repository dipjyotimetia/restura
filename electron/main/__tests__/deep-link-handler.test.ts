// @vitest-environment node

import { parseDeepLink } from '@shared/deep-link';
import { describe, expect, it, vi } from 'vitest';
import { DeepLinkController } from '../lifecycle/deep-link-handler';

function sender(id = 1) {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
  } as unknown as Electron.WebContents;
}

describe('deep-link contract', () => {
  it('accepts only documented actions and query keys', () => {
    expect(parseDeepLink('restura://settings?section=security')).toEqual({
      kind: 'settings',
      section: 'security',
    });
    expect(parseDeepLink('restura://request?id=saved_request-1')).toEqual({
      kind: 'request',
      id: 'saved_request-1',
    });
    expect(parseDeepLink('restura://request?id=one&id=two')).toBeNull();
    expect(parseDeepLink('restura://collection?name=unsafe')).toBeNull();
    expect(parseDeepLink('restura://attacker?id=anything')).toBeNull();
  });

  it.each([
    'restura://import?url=http://169.254.169.254/x',
    'restura://import?url=http://localhost:6443/api',
    'restura://import?url=javascript:alert(1)',
    'restura://import?url=https://user:password@example.com/a.json',
    'restura://import?url=https://example.com/a.json&callback=https://example.com',
  ])('rejects unsafe import source %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('preserves an allowed public import URL and format', () => {
    expect(
      parseDeepLink('restura://import?url=https%3A%2F%2Fexample.com%2Fapi.yaml&format=openapi')
    ).toEqual({
      kind: 'import',
      url: 'https://example.com/api.yaml',
      format: 'openapi',
    });
  });
});

describe('DeepLinkController', () => {
  it('queues before ready, preserves FIFO, and requires acknowledgement', () => {
    const controller = new DeepLinkController();
    const contents = sender();
    controller.receive('restura://settings?section=security');
    controller.receive('restura://collection?id=collection_1');
    expect(contents.send).not.toHaveBeenCalled();
    controller.ready(contents);
    expect(contents.send).toHaveBeenCalledTimes(1);
    const first = vi.mocked(contents.send).mock.calls[0]![1] as { id: string; kind: string };
    expect(first.kind).toBe('settings');
    controller.acknowledge(contents, first.id);
    expect(contents.send).toHaveBeenCalledTimes(2);
    expect((vi.mocked(contents.send).mock.calls[1]![1] as { kind: string }).kind).toBe(
      'collection'
    );
  });

  it('deduplicates pending links and redelivers an unacknowledged link after readiness returns', () => {
    const controller = new DeepLinkController();
    const first = sender(1);
    const reloaded = sender(2);
    controller.receive('restura://settings?section=data');
    controller.receive('restura://settings?section=data');
    controller.ready(first);
    expect(first.send).toHaveBeenCalledTimes(1);
    controller.ready(reloaded);
    expect(reloaded.send).toHaveBeenCalledTimes(1);
    const firstPayload = vi.mocked(first.send).mock.calls[0]![1];
    const retryPayload = vi.mocked(reloaded.send).mock.calls[0]![1];
    expect(retryPayload).toEqual(firstPayload);
  });

  it('does not allow another renderer to acknowledge the active item', () => {
    const controller = new DeepLinkController();
    const primary = sender(1);
    const other = sender(2);
    controller.receive('restura://settings?section=data');
    controller.ready(primary);
    const id = (vi.mocked(primary.send).mock.calls[0]![1] as { id: string }).id;
    controller.acknowledge(other, id);
    controller.ready(primary);
    expect(primary.send).toHaveBeenCalledTimes(2);
  });
});
