import { afterEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { HttpRequest } from '@/types';
import { generateRequestCode } from './requestCode';

const request: HttpRequest = {
  id: 'req-1',
  name: 'r',
  type: 'http',
  method: 'GET',
  url: 'https://{{host}}/x',
  headers: [{ id: 'h', key: 'X-Token', value: '{{token}}', enabled: true }],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const variables = [
  { name: 'host', value: 'api.dev', source: 'base-environment' as const, secret: false },
  { name: 'token', value: 's3cret', source: 'base-environment' as const, secret: true },
];

afterEach(() => useCollectionStore.setState({ collections: [] }));

describe('generateRequestCode', () => {
  it('resolves variables and masks secrets unless asked not to', () => {
    const masked = generateRequestCode(request, 'curl', { variables, maskSecrets: true });
    expect(masked).toContain('https://api.dev/x');
    expect(masked).toContain('X-Token: {{token}}');
    expect(generateRequestCode(request, 'curl', { variables, maskSecrets: false })).toContain(
      'X-Token: s3cret'
    );
  });

  it('applies auth inherited from the collection', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'C',
          auth: { type: 'bearer', bearer: { token: 'tok' } },
          items: [{ id: 'req-1', name: 'r', type: 'request', request }],
        },
      ],
    });
    const out = generateRequestCode(request, 'curl', { variables, maskSecrets: false });
    expect(out).toContain('Authorization: Bearer tok');
  });

  it('notes multipart bodies for languages without form-data support', () => {
    const form: HttpRequest = {
      ...request,
      body: {
        type: 'form-data',
        formData: [{ id: '1', key: 'a', value: 'b', enabled: true, type: 'text' }],
      },
    };
    expect(generateRequestCode(form, 'go', { variables, maskSecrets: true })).toMatch(
      /^\/\/ Note: The multipart form-data body/
    );
    expect(generateRequestCode(form, 'curl', { variables, maskSecrets: true })).not.toContain(
      'Note:'
    );
  });
});
