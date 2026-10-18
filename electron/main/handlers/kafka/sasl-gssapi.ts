import type * as KafkaLib from '@platformatic/kafka';

/**
 * SASL/GSSAPI (Kerberos) for Kafka (#918).
 *
 * `@platformatic/kafka` negotiates the `GSSAPI` mechanism but ships no Kerberos
 * implementation — it requires a custom `authenticate` hook. This module is
 * that hook, driven by the `kerberos` npm package (the MIT/Heimdal GSS-API
 * binding on macOS/Linux, SSPI on Windows) which uses the user's existing
 * ticket cache (`kinit`) or keytab configuration.
 *
 * `kerberos` is a native addon and is NOT bundled with Restura. It is loaded
 * lazily; when it is unavailable the connection fails with an explicit error
 * instead of silently falling back to another mechanism.
 */

/** The subset of the `kerberos` package API this authenticator uses. */
export interface KerberosClientLike {
  contextComplete: boolean;
  step(challenge: string): Promise<string>;
  unwrap(challenge: string): Promise<string>;
  wrap(challenge: string, options?: { user?: string }): Promise<string>;
}

export interface KerberosModuleLike {
  GSS_MECH_OID_KRB5?: number;
  initializeClient(
    service: string,
    options?: { principal?: string; mechOID?: number }
  ): Promise<KerberosClientLike>;
}

export interface KafkaGssapiConfig {
  serviceName?: string | undefined;
  principal?: string | undefined;
}

export const DEFAULT_KERBEROS_SERVICE = 'kafka';
// Bound the GSS-API token exchange so a misbehaving broker can't loop us forever.
const MAX_GSSAPI_ROUNDS = 10;
// Indirected so bundlers/type tooling never try to resolve the optional addon.
const KERBEROS_MODULE_ID = 'kerberos';

export const GSSAPI_UNAVAILABLE_MESSAGE =
  'Kafka GSSAPI (Kerberos) requires the native "kerberos" module, which is not bundled with this build of Restura.';

export function loadKerberosModule(): KerberosModuleLike {
  try {
    return require(KERBEROS_MODULE_ID) as KerberosModuleLike;
  } catch {
    throw new Error(GSSAPI_UNAVAILABLE_MESSAGE);
  }
}

type SaslAuthenticateResponse = KafkaLib.saslAuthenticateV2.SaslAuthenticateResponse;

type SaslSend = (bytes: Buffer) => Promise<SaslAuthenticateResponse>;

function toB64(bytes: Buffer | undefined): string {
  return (bytes ?? Buffer.alloc(0)).toString('base64');
}

/** Host-based SPN: `service@host` (GSS-API) or `service/host` (Windows SSPI). */
export function kerberosServicePrincipal(
  serviceName: string,
  host: string,
  platform: NodeJS.Platform = process.platform
): string {
  return `${serviceName}${platform === 'win32' ? '/' : '@'}${host}`;
}

/**
 * Run the RFC 4752 SASL/GSSAPI client exchange: GSS context establishment,
 * then the security-layer negotiation (unwrap the broker's 4-byte offer, reply
 * with "no security layer" + authorization id via `wrap`).
 */
export async function runGssapiExchange(
  client: KerberosClientLike,
  send: SaslSend,
  principal?: string
): Promise<SaslAuthenticateResponse> {
  let response = await send(Buffer.from(await client.step(''), 'base64'));
  let rounds = 0;
  while (!client.contextComplete) {
    if (++rounds > MAX_GSSAPI_ROUNDS) {
      throw new Error('Kafka GSSAPI context was not established within the round limit.');
    }
    const token = await client.step(toB64(response.authBytes));
    // RFC 4752 §3.1: send the output token even when it is empty.
    response = await send(Buffer.from(token ?? '', 'base64'));
  }
  const offer = await client.unwrap(toB64(response.authBytes));
  const reply = await client.wrap(offer, principal ? { user: principal } : {});
  return send(Buffer.from(reply, 'base64'));
}

/** Build the `@platformatic/kafka` custom authenticator for GSSAPI. */
export function createGssapiAuthenticator(
  config: KafkaGssapiConfig,
  loadKerberos: () => KerberosModuleLike = loadKerberosModule
): KafkaLib.SASLCustomAuthenticator {
  return (_mechanism, connection, authenticate, _u, _p, _t, callback) => {
    const send: SaslSend = (bytes) =>
      new Promise((resolve, reject) => {
        authenticate(connection, bytes, (error, response) => {
          if (error) reject(error);
          else if (!response) reject(new Error('Empty SASL/GSSAPI response from broker.'));
          else resolve(response);
        });
      });

    void (async () => {
      const host = connection.host;
      if (!host) throw new Error('Kafka GSSAPI: broker host is unknown.');
      const kerberos = loadKerberos();
      const client = await kerberos.initializeClient(
        kerberosServicePrincipal(config.serviceName ?? DEFAULT_KERBEROS_SERVICE, host),
        {
          ...(kerberos.GSS_MECH_OID_KRB5 !== undefined
            ? { mechOID: kerberos.GSS_MECH_OID_KRB5 }
            : {}),
          ...(config.principal ? { principal: config.principal } : {}),
        }
      );
      return runGssapiExchange(client, send, config.principal);
    })().then(
      (response) => callback(null, response),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)))
    );
  };
}
