import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importHoppscotchCollection } from './hoppscotch';

describe('importHoppscotchCollection — inherited script scoping', () => {
  it('scopes collection and request scripts so a shared `const` does not redeclare', () => {
    const result = importHoppscotchCollection({
      v: 12,
      name: 'Scoped',
      preRequestScript: 'const x = 1;',
      testScript: "const x = 'collection';",
      folders: [],
      requests: [
        {
          v: '17',
          name: 'Req',
          method: 'GET',
          endpoint: 'https://example.com',
          headers: [],
          params: [],
          preRequestScript: 'const x = 2;',
          testScript: "const x = 'request';",
        },
      ],
    });
    const req = result.collection.items[0]?.request as HttpRequest;
    expect(req.preRequestScript).toContain('inherited from collection');
    expect(req.preRequestScript).toContain('const x = 1;');
    expect(req.preRequestScript).toContain('const x = 2;');
    expect(() => new Function(req.preRequestScript ?? '')).not.toThrow();
    expect(() => new Function(req.testScript ?? '')).not.toThrow();
  });

  it('keeps a lone request script unwrapped', () => {
    const result = importHoppscotchCollection({
      v: 12,
      name: 'Solo',
      folders: [],
      requests: [
        {
          v: '17',
          name: 'Req',
          method: 'GET',
          endpoint: 'https://example.com',
          headers: [],
          params: [],
          preRequestScript: 'const y = 1;',
          testScript: '',
        },
      ],
    });
    const req = result.collection.items[0]?.request as HttpRequest;
    expect(req.preRequestScript).toBe('const y = 1;');
    expect(req.testScript).toBeUndefined();
  });
});
