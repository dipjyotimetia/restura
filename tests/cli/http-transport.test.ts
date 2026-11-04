// @vitest-environment node
/**
 * Root-suite coverage of the CLI's per-request transport settings
 * (`cli/src/runner/executors/http-transport.ts`): each TLS / proxy knob a
 * collection request carries is either applied to a dedicated undici
 * dispatcher or refused with a clear reason — never silently ignored.
 *
 * The proxy tests drive a real loopback proxy so the assertions are on what
 * reaches the wire (Proxy-Authorization, absolute-form target), not on
 * dispatcher internals.
 */
import type { LookupAddress } from 'node:dns';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestSettingsOverride } from '@shared/types';
import { Agent, type Dispatcher, ProxyAgent, request as undiciRequest } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type DnsLookupCallback = (err: NodeJS.ErrnoException | null, records: LookupAddress[]) => void;

const dnsAnswer = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | ((hostname: string) => { err: NodeJS.ErrnoException | null; records: LookupAddress[] }),
}));

// Only `http-transport.ts` (a vite-transformed source module) sees this mock;
// undici's own sockets keep the real resolver.
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>();
  const lookup = (hostname: string, options: unknown, callback: DnsLookupCallback) => {
    const answer = dnsAnswer.current?.(hostname);
    if (answer) {
      queueMicrotask(() => callback(answer.err, answer.records));
      return;
    }
    (real.lookup as unknown as (h: string, o: unknown, c: DnsLookupCallback) => void)(
      hostname,
      options,
      callback
    );
  };
  return { ...real, default: { ...real, lookup }, lookup };
});

import {
  guardedProxyLookup,
  requestConnectOptions,
  requestDispatcher,
} from '../../cli/src/runner/executors/http-transport';

const TARGET = 'https://api.example.com/x';

function proxySettings(proxy: Partial<NonNullable<RequestSettingsOverride['proxy']>> = {}) {
  return {
    proxy: { enabled: true, type: 'http', host: 'proxy.example.com', port: 3128, ...proxy },
  } as RequestSettingsOverride;
}

/** The dispatcher a successful `requestDispatcher` call built (closed by `afterEach`). */
const opened: Dispatcher[] = [];
function dispatcherFor(
  settings: RequestSettingsOverride | undefined,
  url: string,
  opts: Parameters<typeof requestDispatcher>[2] = { allowLocalhost: false }
): Dispatcher | undefined {
  const result = requestDispatcher(settings, url, opts);
  if (!result.ok) throw new Error(result.error);
  if (result.dispatcher) opened.push(result.dispatcher);
  return result.dispatcher;
}

afterEach(async () => {
  dnsAnswer.current = undefined;
  await Promise.all(opened.splice(0).map((d) => d.close()));
});

describe('requestConnectOptions', () => {
  it('returns no options for a request without settings', () => {
    expect(requestConnectOptions(undefined)).toEqual({ ok: true, connect: {} });
    expect(requestConnectOptions({})).toEqual({ ok: true, connect: {} });
  });

  it('only an explicit verifySsl:false relaxes verification (true is the seeded default)', () => {
    expect(requestConnectOptions({ verifySsl: true })).toEqual({ ok: true, connect: {} });
    expect(requestConnectOptions({ verifySsl: false })).toEqual({
      ok: true,
      connect: { rejectUnauthorized: false },
    });
  });

  it('maps CA, TLS floor, cipher list and server cipher order onto tls.connect options', () => {
    expect(
      requestConnectOptions({
        caCert: { pem: 'CA-PEM' },
        minTlsVersion: 'TLSv1.3',
        cipherSuites: 'TLS_AES_256_GCM_SHA384',
        serverCipherOrder: true,
      })
    ).toEqual({
      ok: true,
      connect: {
        ca: 'CA-PEM',
        minVersion: 'TLSv1.3',
        ciphers: 'TLS_AES_256_GCM_SHA384',
        honorCipherOrder: true,
      },
    });
  });

  it('ignores an empty CA and a false server cipher order', () => {
    expect(requestConnectOptions({ caCert: { pem: '' }, serverCipherOrder: false })).toEqual({
      ok: true,
      connect: {},
    });
  });

  it('applies a PEM client cert and key with a plain passphrase', () => {
    expect(
      requestConnectOptions({
        clientCert: { format: 'pem', cert: 'CERT', key: 'KEY', passphrase: 'pw' },
      })
    ).toEqual({ ok: true, connect: { cert: 'CERT', key: 'KEY', passphrase: 'pw' } });
  });

  it('decodes a base64 PFX bundle and unwraps an inline passphrase', () => {
    const result = requestConnectOptions({
      clientCert: {
        format: 'pfx',
        pfx: Buffer.from('pfx-bytes').toString('base64'),
        passphrase: { kind: 'inline', value: 'inline-pw' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.isBuffer(result.connect.pfx)).toBe(true);
    expect((result.connect.pfx as Buffer).toString()).toBe('pfx-bytes');
    expect(result.connect.passphrase).toBe('inline-pw');
    expect(result.connect.cert).toBeUndefined();
  });

  it('omits the passphrase when none (or an empty one) is set', () => {
    expect(
      requestConnectOptions({ clientCert: { format: 'pem', cert: 'C', key: 'K', passphrase: '' } })
    ).toEqual({ ok: true, connect: { cert: 'C', key: 'K' } });
  });

  it('ignores an incomplete client cert (a cert without its key)', () => {
    expect(
      requestConnectOptions({ clientCert: { format: 'pem', cert: 'C', passphrase: 'pw' } })
    ).toEqual({ ok: true, connect: {} });
  });

  it.each([
    ['keychain handle', { kind: 'handle', id: 'h-1' } as const],
    [
      'external secret',
      {
        kind: 'external',
        provider: 'aws-secrets-manager',
        profileId: 'p',
        secretId: 's',
      } as const,
    ],
  ])('refuses a client-cert passphrase held as a %s', (_label, passphrase) => {
    const result = requestConnectOptions({
      clientCert: { format: 'pem', cert: 'C', key: 'K', passphrase },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/client certificate passphrase.*CLI cannot read.*not sent/);
    }
  });
});

describe('requestDispatcher — when a dedicated dispatcher is (not) needed', () => {
  it('uses the run transport for a request with no TLS or proxy settings', () => {
    expect(requestDispatcher(undefined, TARGET, { allowLocalhost: false })).toEqual({ ok: true });
    expect(requestDispatcher({ verifySsl: true }, TARGET, { allowLocalhost: false })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['disabled', proxySettings({ enabled: false })],
    ['type none', proxySettings({ type: 'none' })],
    ['empty host', proxySettings({ host: '' })],
  ])('treats a %s proxy as no proxy', (_label, settings) => {
    expect(requestDispatcher(settings, TARGET, { allowLocalhost: false })).toEqual({ ok: true });
  });

  it('treats a proxy as unused when the request URL does not parse', () => {
    expect(requestDispatcher(proxySettings(), 'not a url', { allowLocalhost: false })).toEqual({
      ok: true,
    });
  });

  it('builds a direct Agent for request-level TLS without any proxy', () => {
    expect(dispatcherFor({ verifySsl: false }, TARGET)).toBeInstanceOf(Agent);
  });

  it('routes request-level TLS through the run --proxy when the request sets no proxy', () => {
    const dispatcher = dispatcherFor({ caCert: { pem: 'CA' } }, TARGET, {
      allowLocalhost: false,
      proxy: 'http://corp-proxy.example.com:8080',
    });
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('sends a bypassed host direct even when the run has a --proxy', () => {
    const settings = proxySettings({ bypassList: ['*.example.com'] });
    const dispatcher = dispatcherFor(settings, TARGET, {
      allowLocalhost: false,
      proxy: 'http://corp-proxy.example.com:8080',
    });
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent);
  });

  it('a bypassed host with run TLS flags still gets a dispatcher carrying them', () => {
    const settings = proxySettings({ bypassList: ['api.example.com'] });
    const dispatcher = dispatcherFor(settings, TARGET, {
      allowLocalhost: false,
      tls: { rejectUnauthorized: false },
    });
    expect(dispatcher).toBeInstanceOf(Agent);
  });

  it('refuses before building anything when the TLS settings are refused', () => {
    const result = requestDispatcher(
      {
        clientCert: { format: 'pem', cert: 'C', key: 'K', passphrase: { kind: 'handle', id: 'x' } },
        ...proxySettings(),
      },
      TARGET,
      { allowLocalhost: false }
    );
    expect(result.ok).toBe(false);
  });
});

describe('requestDispatcher — proxies the CLI cannot apply', () => {
  it.each(['socks4', 'socks5'] as const)('refuses a %s proxy (desktop-only)', (type) => {
    const result = requestDispatcher(proxySettings({ type }), TARGET, { allowLocalhost: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`${type.toUpperCase()} proxy`);
      expect(result.error).toMatch(/SOCKS proxies are desktop-only.*not sent/);
    }
  });

  it('a bypassed host is sent direct (plain Agent) even when the proxy is SOCKS', () => {
    const settings = proxySettings({ type: 'socks5', bypassList: ['api.example.com'] });
    const dispatcher = dispatcherFor(settings, TARGET);
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent);
  });

  it.each([
    ['keychain handle', { kind: 'handle', id: 'pw-handle' } as const],
    [
      'external secret',
      {
        kind: 'external',
        provider: 'azure-key-vault',
        profileId: 'p',
        secretId: 's',
      } as const,
    ],
  ])('refuses a proxy password held as a %s', (_label, password) => {
    const result = requestDispatcher(proxySettings({ auth: { username: 'u', password } }), TARGET, {
      allowLocalhost: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/proxy password.*keychain.*not sent/);
  });

  it.each([
    ['cloud metadata', '169.254.169.254', true],
    ['RFC1918', '172.16.0.1', false],
    ['IPv6 unique-local', 'fd12::1', true],
    ['IPv6 loopback without --allow-localhost', '::1', false],
    ['bracketed IPv6 loopback without --allow-localhost', '[::1]', false],
  ])('refuses a %s proxy host', (_label, host, allowLocalhost) => {
    const result = requestDispatcher(proxySettings({ host }), TARGET, { allowLocalhost });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/proxy host .* is not allowed/);
      expect(result.error).toContain('Use --proxy for an internal proxy');
    }
  });

  it.each(['::1', '[::1]'])('accepts an IPv6 loopback proxy %s with --allow-localhost', (host) => {
    expect(dispatcherFor(proxySettings({ host }), TARGET, { allowLocalhost: true })).toBeInstanceOf(
      ProxyAgent
    );
  });
});

describe('requestDispatcher — the request proxy on the wire', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let proxy: Server;
  let proxyPort: number;
  const seen: Array<{ url: string | undefined; auth: string | undefined }> = [];

  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end('direct'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/hello`;

    // A forward proxy: records what it was asked for, then relays plain HTTP.
    proxy = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
      const forwarded = httpRequest(req.url ?? '', { method: req.method }, (up) => {
        res.writeHead(up.statusCode ?? 502, { 'x-via': 'test-proxy' });
        up.pipe(res);
      });
      forwarded.on('error', () => res.writeHead(502).end());
      forwarded.end();
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });

  async function send(dispatcher: Dispatcher | undefined) {
    const res = await undiciRequest(upstreamUrl, dispatcher ? { dispatcher } : {});
    return { via: res.headers['x-via'], body: await res.body.text() };
  }

  it('sends Basic proxy credentials built from the username and plain password', async () => {
    seen.length = 0;
    const settings = proxySettings({
      host: '127.0.0.1',
      port: proxyPort,
      auth: { username: 'alice', password: 's3cret' },
    });
    const res = await send(dispatcherFor(settings, upstreamUrl, { allowLocalhost: true }));
    expect(res).toEqual({ via: 'test-proxy', body: 'direct' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(upstreamUrl);
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  });

  it('unwraps an inline proxy password', async () => {
    seen.length = 0;
    const settings = proxySettings({
      host: '127.0.0.1',
      port: proxyPort,
      auth: { username: 'bob', password: { kind: 'inline', value: 'pw' } },
    });
    await send(dispatcherFor(settings, upstreamUrl, { allowLocalhost: true }));
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('bob:pw').toString('base64')}`);
  });

  it('sends the username with an empty password when no password is saved', async () => {
    seen.length = 0;
    const settings = proxySettings({
      host: '127.0.0.1',
      port: proxyPort,
      auth: { username: 'carol' } as { username: string; password: string },
    });
    await send(dispatcherFor(settings, upstreamUrl, { allowLocalhost: true }));
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('carol:').toString('base64')}`);
  });

  it('sends no proxy credentials when no username is set', async () => {
    seen.length = 0;
    const settings = proxySettings({
      host: '127.0.0.1',
      port: proxyPort,
      auth: { username: '', password: 'ignored' },
    });
    await send(dispatcherFor(settings, upstreamUrl, { allowLocalhost: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBeUndefined();
  });

  it('the request proxy replaces the run --proxy', async () => {
    seen.length = 0;
    const settings = proxySettings({ host: '127.0.0.1', port: proxyPort });
    const res = await send(
      dispatcherFor(settings, upstreamUrl, {
        allowLocalhost: true,
        proxy: 'http://127.0.0.1:1',
      })
    );
    expect(res.via).toBe('test-proxy');
    expect(seen).toHaveLength(1);
  });

  it('a bypassed target skips both the request proxy and the run --proxy', async () => {
    seen.length = 0;
    const settings = proxySettings({
      host: '127.0.0.1',
      port: proxyPort,
      bypassList: ['127.0.0.1'],
    });
    const res = await send(
      dispatcherFor(settings, upstreamUrl, {
        allowLocalhost: true,
        proxy: `http://127.0.0.1:${proxyPort}`,
      })
    );
    expect(res).toEqual({ via: undefined, body: 'direct' });
    expect(seen).toHaveLength(0);
  });
});

describe('guardedProxyLookup — the SSRF guard on the address actually dialled', () => {
  type Answer = { err: Error | null; address: string | LookupAddress[]; family?: number };
  const lookupWith = (allowLocalhost: boolean, options: unknown, host = 'proxy.example.com') =>
    new Promise<Answer>((done) => {
      const cb = (err: Error | null, address: string | LookupAddress[], family?: number) =>
        done({ err, address, family });
      if (typeof options === 'function') {
        // `lookup(host, callback)` call shape.
        (guardedProxyLookup(allowLocalhost) as (h: string, o: unknown) => void)(host, cb);
      } else {
        guardedProxyLookup(allowLocalhost)(host, options, cb);
      }
    });

  it('returns the first public address for a single-address lookup', async () => {
    dnsAnswer.current = () => ({
      err: null,
      records: [
        { address: '203.0.113.7', family: 4 },
        { address: '2001:db8::7', family: 6 },
      ],
    });
    expect(await lookupWith(false, {})).toEqual({
      err: null,
      address: '203.0.113.7',
      family: 4,
    });
  });

  it('supports the (hostname, callback) call shape', async () => {
    dnsAnswer.current = () => ({ err: null, records: [{ address: '2001:db8::1', family: 6 }] });
    expect(await lookupWith(false, 'callback')).toEqual({
      err: null,
      address: '2001:db8::1',
      family: 6,
    });
  });

  it('returns every record when all addresses are requested', async () => {
    const records = [
      { address: '203.0.113.7', family: 4 },
      { address: '203.0.113.8', family: 4 },
    ];
    dnsAnswer.current = () => ({ err: null, records });
    expect((await lookupWith(false, { all: true })).address).toEqual(records);
  });

  it('refuses when any resolved address is cloud metadata, even with --allow-localhost', async () => {
    dnsAnswer.current = () => ({
      err: null,
      records: [
        { address: '203.0.113.7', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    const answer = await lookupWith(true, { all: true });
    expect(answer.err?.message).toMatch(/cloud metadata/);
    expect(answer.address).toEqual([]);
  });

  it('refuses a name that resolves to a private address', async () => {
    dnsAnswer.current = () => ({ err: null, records: [{ address: '10.1.2.3', family: 4 }] });
    const answer = await lookupWith(true, {});
    expect(answer.err?.message).toMatch(/private address 10\.1\.2\.3/);
    expect(answer.address).toBe('');
  });

  it('gates a loopback answer on --allow-localhost', async () => {
    dnsAnswer.current = () => ({ err: null, records: [{ address: '127.0.0.1', family: 4 }] });
    expect((await lookupWith(false, {})).err?.message).toMatch(/loopback/);
    expect(await lookupWith(true, {})).toEqual({ err: null, address: '127.0.0.1', family: 4 });
  });

  it('fails when the name resolves to no address', async () => {
    dnsAnswer.current = () => ({ err: null, records: [] });
    const answer = await lookupWith(false, { all: true });
    expect(answer.err?.message).toBe('Proxy host proxy.example.com did not resolve');
    expect(answer.address).toEqual([]);
  });

  it('passes a resolver error through, shaped for the requested form', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    dnsAnswer.current = () => ({ err: failure, records: [] });
    expect(await lookupWith(false, {})).toEqual({ err: failure, address: '', family: undefined });
    expect((await lookupWith(false, { all: true })).address).toEqual([]);
  });
});
