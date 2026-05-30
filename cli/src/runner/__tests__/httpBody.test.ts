import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter } from '../../reporters/types';

// Captures the wire body + content-type each request sends so we can assert
// the CLI serialises structured form bodies (the shape OpenCollection exports
// produce) rather than silently sending an empty body.

interface Captured {
  contentType: string | undefined;
  body: string;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];

beforeAll(async () => {
  captured = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      captured.push({
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.statusCode = 200;
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function bodyCollection(requestYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-body-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: BodyTests\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(join(dir, 'a.http.yaml'), requestYaml, 'utf-8');
  return dir;
}

describe('CLI body building — structured forms', () => {
  it('serialises a structured x-www-form-urlencoded body (OpenCollection shape)', async () => {
    const dir = bodyCollection(
      `name: Form\nmethod: POST\nurl: '{{BASE}}/form'\nbody:\n` +
        `  type: x-www-form-urlencoded\n  formData:\n` +
        `    - { key: username, value: alice, enabled: true, type: text }\n` +
        `    - { key: role, value: admin, enabled: true, type: text }\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const last = captured[captured.length - 1]!;
    expect(last.contentType).toContain('application/x-www-form-urlencoded');
    expect(last.body).toBe('username=alice&role=admin');
  });

  it('resolves variables inside form fields and skips disabled / file parts', async () => {
    const dir = bodyCollection(
      `name: Form\nmethod: POST\nurl: '{{BASE}}/form'\nbody:\n` +
        `  type: x-www-form-urlencoded\n  formData:\n` +
        `    - { key: token, value: '{{BASE}}', enabled: true, type: text }\n` +
        `    - { key: skip, value: nope, enabled: false, type: text }\n` +
        `    - { key: upload, value: x, enabled: true, type: file }\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const last = captured[captured.length - 1]!;
    expect(last.body).toBe(`token=${encodeURIComponent(baseUrl)}`);
  });
});
