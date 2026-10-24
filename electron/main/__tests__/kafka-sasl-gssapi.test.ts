import { describe, expect, it, vi } from 'vitest';
import {
  createGssapiAuthenticator,
  GSSAPI_UNAVAILABLE_MESSAGE,
  type KerberosClientLike,
  type KerberosModuleLike,
  kerberosServicePrincipal,
  loadKerberosModule,
} from '../handlers/kafka/sasl-gssapi';

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Fake two-leg Kerberos client: AP-REQ → AP-REP completes the context. */
function fakeClient(): KerberosClientLike & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    contextComplete: false,
    async step(challenge: string) {
      calls.push(`step:${Buffer.from(challenge, 'base64').toString()}`);
      if (challenge === '') return b64('AP-REQ');
      client.contextComplete = true;
      return '';
    },
    async unwrap(challenge: string) {
      calls.push(`unwrap:${Buffer.from(challenge, 'base64').toString()}`);
      return b64('offer');
    },
    async wrap(challenge: string, options?: { user?: string }) {
      calls.push(`wrap:${Buffer.from(challenge, 'base64').toString()}:${options?.user ?? ''}`);
      return b64('no-layer');
    },
  };
  return client;
}

type Respond = (bytes: Buffer) => string;

function run(
  kerberos: KerberosModuleLike,
  respond: Respond,
  config = {},
  host: string | undefined = 'broker-1.corp'
) {
  const sent: string[] = [];
  const authenticate = vi.fn(
    (_conn: unknown, bytes: Buffer, cb: (e: Error | null, r?: unknown) => void) => {
      sent.push(bytes.toString());
      queueMicrotask(() =>
        cb(null, {
          errorCode: 0,
          errorMessage: null,
          authBytes: Buffer.from(respond(bytes)),
          sessionLifetimeMs: 0n,
        })
      );
    }
  );
  const authenticator = createGssapiAuthenticator(config, () => kerberos);
  return new Promise<{ error: Error | null; response: unknown; sent: string[] }>((resolve) => {
    authenticator(
      'GSSAPI',
      { host } as never,
      authenticate as never,
      undefined,
      undefined,
      undefined,
      ((error: Error | null, response: unknown) => resolve({ error, response, sent })) as never
    );
  });
}

describe('kafka GSSAPI authenticator', () => {
  it('runs context establishment then the RFC 4752 security-layer reply', async () => {
    const client = fakeClient();
    const initializeClient = vi.fn(async () => client);
    const { error, sent } = await run(
      { GSS_MECH_OID_KRB5: 9, initializeClient },
      (bytes) => {
        const msg = bytes.toString();
        if (msg === 'AP-REQ') return 'AP-REP';
        if (msg === '') return 'wrapped-offer';
        return '';
      },
      { serviceName: 'kafka', principal: 'alice@CORP.EXAMPLE' }
    );
    expect(error).toBeNull();
    expect(initializeClient).toHaveBeenCalledWith(
      kerberosServicePrincipal('kafka', 'broker-1.corp'),
      { mechOID: 9, principal: 'alice@CORP.EXAMPLE' }
    );
    // AP-REQ, empty final context token, then the wrapped "no security layer" reply.
    expect(sent).toEqual(['AP-REQ', '', 'no-layer']);
    expect(client.calls).toEqual([
      'step:',
      'step:AP-REP',
      'unwrap:wrapped-offer',
      'wrap:offer:alice@CORP.EXAMPLE',
    ]);
  });

  it('defaults the service name to "kafka"', async () => {
    const initializeClient = vi.fn(async () => fakeClient());
    await run({ initializeClient }, () => 'x');
    expect(initializeClient).toHaveBeenCalledWith(
      kerberosServicePrincipal('kafka', 'broker-1.corp'),
      {}
    );
  });

  it('fails with an explicit message when the kerberos addon is unavailable', async () => {
    const authenticator = createGssapiAuthenticator({}, () => {
      throw new Error(GSSAPI_UNAVAILABLE_MESSAGE);
    });
    const error = await new Promise<Error | null>((resolve) => {
      authenticator(
        'GSSAPI',
        { host: 'broker' } as never,
        vi.fn() as never,
        undefined,
        undefined,
        undefined,
        ((e: Error | null) => resolve(e)) as never
      );
    });
    expect(error?.message).toBe(GSSAPI_UNAVAILABLE_MESSAGE);
  });

  it('the default loader reports the missing native module honestly', () => {
    expect(() => loadKerberosModule()).toThrow(GSSAPI_UNAVAILABLE_MESSAGE);
  });

  it('rejects when the broker host is unknown or the broker errors', async () => {
    const noHost = await run({ initializeClient: async () => fakeClient() }, () => '', {}, '');
    expect(noHost.error?.message).toMatch(/broker host is unknown/);

    const authenticator = createGssapiAuthenticator({}, () => ({
      initializeClient: async () => fakeClient(),
    }));
    const error = await new Promise<Error | null>((resolve) => {
      authenticator(
        'GSSAPI',
        { host: 'b' } as never,
        ((_c: unknown, _b: Buffer, cb: (e: Error) => void) => cb(new Error('denied'))) as never,
        undefined,
        undefined,
        undefined,
        ((e: Error | null) => resolve(e)) as never
      );
    });
    expect(error?.message).toBe('denied');
  });

  it('times out a stalled exchange', async () => {
    vi.useFakeTimers();
    try {
      const authenticator = createGssapiAuthenticator(
        {},
        () => ({ initializeClient: () => new Promise<never>(() => {}) }),
        5_000
      );
      const result = new Promise<Error | null>((resolve) => {
        authenticator(
          'GSSAPI',
          { host: 'b' } as never,
          vi.fn() as never,
          undefined,
          undefined,
          undefined,
          ((e: Error | null) => resolve(e)) as never
        );
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await result)?.message).toMatch(/timed out after 5000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the token exchange', async () => {
    const neverCompletes: KerberosClientLike = {
      contextComplete: false,
      step: async () => b64('more'),
      unwrap: async () => '',
      wrap: async () => '',
    };
    const { error } = await run({ initializeClient: async () => neverCompletes }, () => 'again');
    expect(error?.message).toMatch(/round limit/);
  });

  it('formats Windows SSPI service principals with a slash', () => {
    expect(kerberosServicePrincipal('kafka', 'b1', 'win32')).toBe('kafka/b1');
    expect(kerberosServicePrincipal('kafka', 'b1', 'linux')).toBe('kafka@b1');
  });
});
