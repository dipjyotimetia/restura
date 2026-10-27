import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem } from '../../types';
import {
  describePostmanAuthBlock,
  nextPostmanAuthGuard,
  postmanAuthBlock,
  postmanBlockedReason,
  postmanBlockedReasonFor,
} from './auth-guard';
import { importPostmanCollection } from './index';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const BEARER = { type: 'bearer', bearer: { token: 't' } } as const;

const reqItem = (name: string, extra: Record<string, unknown> = {}): CollectionItem =>
  ({
    id: name,
    name,
    type: 'request',
    request: {
      id: `r-${name}`,
      name,
      type: 'http',
      method: 'GET',
      url: 'https://x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
    ...extra,
  }) as CollectionItem;

describe('postmanAuthBlock', () => {
  it('a request with its own configured auth is never blocked', () => {
    const item = reqItem('a', { _postman: { noauth: true } });
    expect(postmanAuthBlock(item, { configured: { owner: 'C' } }, BEARER)).toBeUndefined();
    expect(
      postmanBlockedReason(item, { unsupported: { type: 'hawk', owner: 'F' } }, 'X', BEARER)
    ).toBeUndefined();
  });

  it('own unsupported auth, inherited unsupported, own and inherited noauth', () => {
    expect(postmanAuthBlock(reqItem('a', { _postman: { auth: { type: 'jwt' } } }), {})).toEqual({
      kind: 'unsupported',
      type: 'jwt',
    });
    expect(postmanAuthBlock(reqItem('a'), { unsupported: { type: 'hawk', owner: 'F' } })).toEqual({
      kind: 'unsupported',
      type: 'hawk',
      owner: 'F',
    });
    expect(
      postmanAuthBlock(reqItem('a', { _postman: { noauth: true } }), { configured: { owner: 'C' } })
    ).toEqual({ kind: 'noauth', source: 'C' });
    expect(
      postmanAuthBlock(reqItem('a'), { noauth: { owner: 'NF' }, configured: { owner: 'C' } })
    ).toEqual({ kind: 'noauth', source: 'C', owner: 'NF' });
  });

  it('noauth with nothing configured above, or a plain inheriting request, is sendable', () => {
    expect(postmanAuthBlock(reqItem('a', { _postman: { noauth: true } }), {})).toBeUndefined();
    expect(postmanAuthBlock(reqItem('a'), { noauth: { owner: 'NF' } })).toBeUndefined();
    expect(postmanAuthBlock(reqItem('a'), { configured: { owner: 'C' } })).toBeUndefined();
  });

  it('describes both kinds with the sender named', () => {
    expect(describePostmanAuthBlock({ kind: 'unsupported', type: 'hawk' }, 'the CLI')).toBe(
      'not sent: Postman auth type "hawk" is not supported by Restura (imported as no auth); ' +
        'the CLI will not send it unauthenticated. Configure a supported auth or exclude the request.'
    );
    expect(
      describePostmanAuthBlock({ kind: 'noauth', source: 'C', owner: 'NF' }, 'Restura')
    ).toMatch(
      /^not sent: Postman auth is "No Auth" \(inherited from "NF"\).*"C".*Restura will not/
    );
  });
});

describe('nextPostmanAuthGuard', () => {
  it('a configured container resets the cut; an unsupported / noauth one keeps the configured source', () => {
    const configured = nextPostmanAuthGuard({}, {
      auth: BEARER,
      name: 'C',
    } as unknown as Collection);
    expect(configured).toEqual({ configured: { owner: 'C' } });
    const folder = (extra: Record<string, unknown>) =>
      ({ id: 'f', name: 'F', type: 'folder', items: [], ...extra }) as CollectionItem;
    expect(
      nextPostmanAuthGuard(configured, folder({ _postman: { auth: { type: 'hawk' } } }))
    ).toEqual({ unsupported: { type: 'hawk', owner: 'F' }, configured: { owner: 'C' } });
    expect(nextPostmanAuthGuard(configured, folder({ _postman: { noauth: true } }))).toEqual({
      noauth: { owner: 'F' },
      configured: { owner: 'C' },
    });
    expect(nextPostmanAuthGuard({}, folder({ _postman: { noauth: true } }))).toEqual({
      noauth: { owner: 'F' },
    });
    expect(nextPostmanAuthGuard(configured, folder({}))).toBe(configured);
  });
});

describe('postmanBlockedReasonFor', () => {
  it('walks folders to the request and returns undefined for unknown ids', () => {
    const { collection } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] },
      item: [
        { name: 'Plain', item: [{ name: 'Inner', request: 'https://x/i' }] },
        { name: 'NF', auth: { type: 'noauth' }, item: [{ name: 'Child', request: 'https://x/c' }] },
      ],
    });
    const id = (folder: number) => collection.items[folder]?.items?.[0]?.request?.id ?? '';
    expect(postmanBlockedReasonFor(collection, id(0), 'Restura')).toBeUndefined();
    expect(postmanBlockedReasonFor(collection, id(1), 'Restura')).toMatch(/inherited from "NF"/);
    expect(postmanBlockedReasonFor(collection, id(1), 'Restura', BEARER)).toBeUndefined();
    expect(postmanBlockedReasonFor(collection, 'missing', 'Restura')).toBeUndefined();
  });

  it('v3 multi-entry auth whose first set is noauth is marked too', () => {
    const { collection } = importPostmanCollection({
      $kind: 'collection',
      name: 'V3',
      auth: { type: 'bearer', credentials: [{ key: 'token', value: 't' }] },
      items: [
        {
          $kind: 'http-request',
          name: 'Multi',
          method: 'GET',
          url: 'https://x/m',
          auth: [{ type: 'noauth' }, { type: 'basic', credentials: [] }],
        },
      ],
    });
    const item = collection.items[0] as CollectionItem & { _postman?: { noauth?: true } };
    expect(item._postman?.noauth).toBe(true);
    expect(postmanBlockedReasonFor(collection, item.request?.id ?? '', 'Restura')).toMatch(
      /No Auth/
    );
  });
});
