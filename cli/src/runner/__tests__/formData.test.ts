import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;
let received: { contentType: string; body: string } | undefined;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received = {
        contentType: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

/** Legacy collection with a multipart/form-data body: one text field + one file part. */
function makeCollection(): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-fd-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: FD\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  // file value 'aGVsbG8=' = base64('hello')
  const body = {
    type: 'form-data',
    formData: [
      { key: 'greeting', value: 'hi {{BASE}}', enabled: true, type: 'text' },
      {
        key: 'upload',
        value: 'aGVsbG8=',
        enabled: true,
        type: 'file',
        fileName: 'a.txt',
        contentType: 'text/plain',
      },
    ],
  };
  writeFileSync(
    join(dir, 'post.http.yaml'),
    `name: Upload\nmethod: POST\nurl: '{{BASE}}/upload'\nbody: ${JSON.stringify(body)}\n`,
    'utf-8'
  );
  return dir;
}

const RUN_OPTS = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

describe('runCollection — multipart/form-data', () => {
  it('sends a multipart body with text and file parts', async () => {
    const result = await runCollection(makeCollection(), RUN_OPTS, new NoopReporter());
    expect(result.requests[0]!.passed).toBe(true);
    expect(received).toBeDefined();
    expect(received!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    // Text field (with variable resolved).
    expect(received!.body).toContain('name="greeting"');
    expect(received!.body).toContain(`hi ${baseUrl}`);
    // File part: filename + content-type + decoded bytes ('hello').
    expect(received!.body).toContain('name="upload"; filename="a.txt"');
    expect(received!.body).toContain('Content-Type: text/plain');
    expect(received!.body).toContain('hello');
  });
});
