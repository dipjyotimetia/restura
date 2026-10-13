import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter, RequestRunResult } from '../../reporters/types';
import { runCollection } from '../runner';

// #855: a response with several Set-Cookie fields must reach the run result
// (and test scripts) with every cookie, not one folded/last-wins value.

const COOKIES = [
  'session=abc; Path=/; HttpOnly',
  'csrf=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
  'pref=dark',
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Set-Cookie', COOKIES);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class CaptureReporter implements Reporter {
  results: RequestRunResult[] = [];
  onRequestComplete(result: RequestRunResult): void {
    this.results.push(result);
  }
  onEnd(): void {}
}

describe('CLI runner — multiple Set-Cookie', () => {
  it('keeps every Set-Cookie field on the request result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-cookies-'));
    writeFileSync(join(dir, '_collection.yaml'), 'name: Cookies\n', 'utf-8');
    writeFileSync(
      join(dir, 'a.http.yaml'),
      `name: Login\nmethod: GET\nurl: '${baseUrl}/login'\n`,
      'utf-8'
    );
    const reporter = new CaptureReporter();
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );
    expect(reporter.results).toHaveLength(1);
    expect(reporter.results[0]?.setCookies).toEqual(COOKIES);
  });

  it('gives test scripts every cookie and the same joined set-cookie header as other harnesses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-cookies-'));
    writeFileSync(join(dir, '_collection.yaml'), 'name: Cookies\n', 'utf-8');
    const script = [
      // Expected value written as a literal: building script source from data is what CodeQL flags.
      "pm.test('joined', () => pm.expect(response.headers['set-cookie']).to.equal('session=abc; Path=/; HttpOnly, csrf=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, pref=dark'));",
      `pm.test('list', () => pm.expect(response.setCookies.length).to.equal(3));`,
      `pm.test('parsed', () => pm.expect(pm.response.cookies.get('csrf')).to.equal('xyz'));`,
    ].join('\n  ');
    writeFileSync(
      join(dir, 'a.http.yaml'),
      `name: Login\nmethod: GET\nurl: '${baseUrl}/login'\ntestScript: |\n  ${script}\n`,
      'utf-8'
    );
    const reporter = new CaptureReporter();
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );
    expect(reporter.results[0]?.assertions).toEqual([
      { name: 'joined', passed: true },
      { name: 'list', passed: true },
      { name: 'parsed', passed: true },
    ]);
  });
});
