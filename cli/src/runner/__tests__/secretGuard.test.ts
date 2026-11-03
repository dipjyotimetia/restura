import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetcher } from '@shared/protocol/types';
import type { HttpRequest } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reporter } from '../../reporters/types';
import type { LoadedRequest } from '../collectionLoader';
import { executeRequest } from '../executors/dispatch';
import { executeSse } from '../executors/sse';
import { runCollection } from '../runner';

/**
 * A variable the CLI cannot resolve (secret, private, handle-backed) never goes
 * out as a literal `{{name}}`: folder-level secrets fail the item in the runner,
 * and every executor refuses before any I/O, whatever the entry point.
 */

let server: Server;
let baseUrl: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.url} ${req.headers['x-token'] ?? ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  hits.length = 0;
});

class Quiet implements Reporter {
  onEnd(): void {}
}

function folderSecretCollection(): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-secret-guard-'));
  const file = join(dir, 'collection.yaml');
  writeFileSync(
    file,
    `opencollection: "1.0.0"
info:
  name: FolderSecret
bundled: true
items:
  - info:
      name: api
      seq: 1
    request:
      variables:
        - name: token
          secret: true
        - name: plain
          value: P
    items:
      - info: { type: http, name: Use, seq: 1 }
        http:
          method: GET
          url: "${baseUrl}/use?p={{plain}}"
          headers:
            - name: X-Token
              value: "{{token}}"
`
  );
  return file;
}

function httpItem(extra: Partial<LoadedRequest>): LoadedRequest {
  return {
    relativePath: 'R',
    folderPath: [],
    type: 'http',
    request: {
      id: 'r',
      name: 'R',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: [{ id: 'h', key: 'Authorization', value: 'Bearer {{tok}}', enabled: true }],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    } as HttpRequest,
    ...extra,
  };
}

describe('CLI unresolvable-variable guard', () => {
  it('a folder-level secret variable with no value fails the item: not sent', async () => {
    const result = await runCollection(
      folderSecretCollection(),
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new Quiet()
    );
    expect(hits).toEqual([]);
    expect(result.requests[0]).toMatchObject({ passed: false, notSent: true });
    expect(result.requests[0]?.errorMessage).toMatch(/secret variable "token" has no value/);
  });

  it('a folder-level secret variable supplied with --env is sent', async () => {
    const result = await runCollection(
      folderSecretCollection(),
      { envVars: { token: 'T' }, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new Quiet()
    );
    expect(result.requests[0]?.passed, result.requests[0]?.errorMessage).toBe(true);
    expect(hits).toEqual(['/use?p=P T']);
  });

  it.each([
    [{ privateVariableNames: ['tok'] }, 'Private variable "tok" is unavailable'],
    [{ secretVariableNames: ['tok'] }, 'secret variable "tok" has no value'],
  ] as const)(
    'the executor refuses an unresolved name before any I/O (%o)',
    async (names, message) => {
      const fetcher = vi.fn<Fetcher>();
      const item = httpItem(names);
      const outcome = await executeRequest(item, {
        vars: {},
        timeoutMs: 1000,
        allowLocalhost: false,
        fetcher,
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ passed: false, refused: true });
      expect(outcome.errorMessage).toContain(message);

      const supplied = await executeRequest(item, {
        vars: { tok: 'v' },
        timeoutMs: 1000,
        allowLocalhost: false,
        fetcher: async () => {
          throw new Error('stub network failure');
        },
      });
      expect(supplied.refused).toBeUndefined();
      expect(supplied.errorMessage).toContain('stub network failure');
    }
  );

  it.each([
    [{ privateVariableNames: ['tok'] }, 'Private variable "tok" is unavailable'],
    [{ secretVariableNames: ['tok'] }, 'secret variable "tok" has no value'],
  ] as const)(
    'an empty value counts as missing: never sent as "Bearer " (%o)',
    async (names, message) => {
      // e.g. `tok: ${CI_TOKEN}` in an env file with CI_TOKEN unset expands to ''.
      const fetcher = vi.fn<Fetcher>();
      const outcome = await executeRequest(httpItem(names), {
        vars: { tok: '' },
        timeoutMs: 1000,
        allowLocalhost: false,
        fetcher,
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ passed: false, refused: true });
      expect(outcome.errorMessage).toContain(message);
    }
  );
});

describe('executor type-mismatch refusal', () => {
  it('the SSE executor refuses a non-SSE item as a deterministic refusal', async () => {
    const outcome = await executeSse(httpItem({}), {
      vars: {},
      timeoutMs: 1000,
      allowLocalhost: false,
    });
    expect(outcome).toMatchObject({ passed: false, refused: true, status: 0 });
    expect(outcome.errorMessage).toBe('SSE executor received non-sse request: http');
  });
});
