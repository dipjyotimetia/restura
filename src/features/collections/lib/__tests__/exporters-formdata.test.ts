import { describe, expect, it } from 'vitest';
import type { AuthConfig, Collection, HttpRequest } from '@/types';
import { exportToHAR, exportToInsomnia, getCollectionExportWarnings } from '../exporters';
import { importInsomniaCollection } from '../importers/insomnia';

const collectionWith = (request: Partial<HttpRequest>): Collection => ({
  id: 'c',
  name: 'C',
  items: [
    {
      id: 'i',
      name: 'r',
      type: 'request',
      request: {
        id: 'r',
        name: 'r',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com/upload',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        ...request,
      },
    },
  ],
});

const multipart = collectionWith({
  body: {
    type: 'form-data',
    formData: [
      { id: '1', key: 'title', value: 'hello', enabled: true, type: 'text' },
      { id: '2', key: 'off', value: 'x', enabled: false, type: 'text' },
      {
        id: '3',
        key: 'doc',
        value: 'QUJD',
        enabled: true,
        type: 'file',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
      },
    ],
  },
});

const urlencoded = collectionWith({
  body: {
    type: 'x-www-form-urlencoded',
    formData: [
      { id: '1', key: 'q', value: 'a b', enabled: true, type: 'text' },
      { id: '2', key: 'off', value: 'y', enabled: false, type: 'text' },
    ],
  },
});

const insomniaBody = (collection: Collection) =>
  exportToInsomnia(collection).resources.find((r) => r._type === 'request')?.body as
    | { mimeType: string; text: string; params?: unknown[] }
    | undefined;

interface HarPostData {
  mimeType: string;
  text?: string;
  params?: unknown[];
}
const harPostData = (collection: Collection): HarPostData | undefined =>
  (exportToHAR(collection) as { log: { entries: Array<{ request: { postData?: HarPostData } }> } })
    .log.entries[0]?.request.postData;

describe('Insomnia export of field-based bodies', () => {
  it('emits multipart fields as params, files typed as file without their bytes', () => {
    expect(insomniaBody(multipart)).toEqual({
      mimeType: 'multipart/form-data',
      text: '',
      params: [
        { name: 'title', value: 'hello', disabled: false },
        { name: 'off', value: 'x', disabled: true },
        { name: 'doc', value: '', fileName: 'a.pdf', type: 'file', disabled: false },
      ],
    });
  });

  it('emits urlencoded fields as params and round-trips through the importer', () => {
    expect(insomniaBody(urlencoded)?.params).toEqual([
      { name: 'q', value: 'a b', disabled: false },
      { name: 'off', value: 'y', disabled: true },
    ]);
    const { collection } = importInsomniaCollection(exportToInsomnia(urlencoded));
    const body = (collection.items[0]?.request as HttpRequest).body;
    expect(body.type).toBe('x-www-form-urlencoded');
    expect(body.formData?.map((f) => [f.key, f.value, f.enabled])).toEqual([
      ['q', 'a b', true],
      ['off', 'y', false],
    ]);
  });

  it('warns when an auth type Insomnia export cannot carry is dropped', () => {
    const dropped: AuthConfig[] = [
      { type: 'digest', digest: { username: 'u', password: 'p' } },
      { type: 'oauth1', oauth1: { consumerKey: 'k', consumerSecret: 's' } },
      { type: 'ntlm', ntlm: { username: 'u', password: 'p' } },
      {
        type: 'aws-signature',
        awsSignature: { accessKey: 'a', secretKey: 's', region: 'r', service: 's3' },
      },
      { type: 'wsse', wsse: { username: 'u', password: 'p' } },
    ];
    for (const auth of dropped) {
      const warnings = getCollectionExportWarnings(collectionWith({ auth }), 'insomnia');
      expect(warnings.some((w) => /Insomnia export omits .* auth/.test(w))).toBe(true);
    }
    expect(
      getCollectionExportWarnings(
        collectionWith({ auth: { type: 'bearer', bearer: { token: 't' } } }),
        'insomnia'
      )
    ).toEqual([]);
  });
});

describe('HAR export of field-based bodies', () => {
  it('emits enabled multipart fields as postData.params', () => {
    expect(harPostData(multipart)).toEqual({
      mimeType: 'multipart/form-data',
      params: [
        { name: 'title', value: 'hello' },
        { name: 'doc', fileName: 'a.pdf', contentType: 'application/pdf' },
      ],
    });
  });

  it('emits urlencoded fields as params plus the serialized text', () => {
    expect(harPostData(urlencoded)).toEqual({
      mimeType: 'application/x-www-form-urlencoded',
      params: [{ name: 'q', value: 'a b' }],
      text: 'q=a%20b',
    });
  });
});
