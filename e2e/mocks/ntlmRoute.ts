import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AuthRoute } from './authRoutes';

/**
 * `GET /ntlm/protected` — an NTLMv2 (MS-NLMP) server for #1069.
 *
 * Independent of the desktop client's codec (electron/main/handlers/ntlm-message.ts):
 * it shares no code, and the NT hash of the fixture password is a constant
 * here rather than recomputed with the client's MD4.
 *
 * NTLM authenticates a connection, so the type 2 challenge is remembered per
 * socket: a type 3 that arrives on a different socket than the one that got
 * the challenge (a pool hop) is rejected, exactly like IIS.
 */

export const NTLM_FIXTURE = {
  username: 'alice',
  password: 'wonderland',
  domain: 'RESTURA',
} as const;

/** MD4(UTF-16LE("wonderland")) — recompute if the fixture password changes. */
const NT_HASH = Buffer.from('3e057cd123205aa168af5f121716b335', 'hex');

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const challenges = new WeakMap<Socket, Buffer>();

function avPair(id: number, value: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(value.length, 2);
  return Buffer.concat([head, value]);
}

function type2(serverChallenge: Buffer): string {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE((BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n);
  const targetName = Buffer.from(NTLM_FIXTURE.domain, 'utf16le');
  const targetInfo = Buffer.concat([
    avPair(2, targetName), // MsvAvNbDomainName
    avPair(1, Buffer.from('ECHO', 'utf16le')), // MsvAvNbComputerName
    avPair(7, timestamp), // MsvAvTimestamp
    avPair(0, Buffer.alloc(0)), // MsvAvEOL
  ]);
  const header = Buffer.alloc(48);
  SIGNATURE.copy(header, 0);
  header.writeUInt32LE(2, 8);
  header.writeUInt16LE(targetName.length, 12);
  header.writeUInt16LE(targetName.length, 14);
  header.writeUInt32LE(48, 16);
  // UNICODE | REQUEST_TARGET | NTLM | ALWAYS_SIGN | TARGET_TYPE_DOMAIN |
  // EXTENDED_SESSIONSECURITY | TARGET_INFO | 128 | 56
  header.writeUInt32LE(0xa28a8205 >>> 0, 20);
  serverChallenge.copy(header, 24);
  header.writeUInt16LE(targetInfo.length, 40);
  header.writeUInt16LE(targetInfo.length, 42);
  header.writeUInt32LE(48 + targetName.length, 44);
  return Buffer.concat([header, targetName, targetInfo]).toString('base64');
}

function field(msg: Buffer, at: number): Buffer {
  const len = msg.readUInt16LE(at);
  const off = msg.readUInt32LE(at + 4);
  if (off + len > msg.length) throw new Error('field out of bounds');
  return msg.subarray(off, off + len);
}

function hmacMd5(key: Buffer, ...data: Buffer[]): Buffer {
  const h = createHmac('md5', key);
  for (const d of data) h.update(d);
  return h.digest();
}

/** Verify an NTLMv2 AUTHENTICATE message against the fixture credentials. */
function verifyType3(msg: Buffer, serverChallenge: Buffer): { ok: boolean; reason?: string } {
  const nt = field(msg, 20);
  const domain = field(msg, 28).toString('utf16le');
  const user = field(msg, 36).toString('utf16le');
  if (user.toLowerCase() !== NTLM_FIXTURE.username) return { ok: false, reason: 'unknown user' };
  if (nt.length < 48) return { ok: false, reason: 'not an NTLMv2 response' };
  const key = hmacMd5(NT_HASH, Buffer.from(user.toUpperCase() + domain, 'utf16le'));
  const proof = hmacMd5(key, serverChallenge, nt.subarray(16));
  return timingSafeEqual(proof, nt.subarray(0, 16))
    ? { ok: true }
    : { ok: false, reason: 'NTLMv2 proof mismatch' };
}

export const ntlmProtectedEndpoint: AuthRoute = {
  method: 'GET',
  test: '/ntlm/protected',
  handle: ({ req, res }) => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const m = /^NTLM\s+([A-Za-z0-9+/]+=*)$/i.exec(String(req.headers.authorization ?? ''));
    if (!m) {
      reply(401, { authenticated: false }, { 'www-authenticate': 'NTLM' });
      return;
    }
    const msg = Buffer.from(m[1]!, 'base64');
    if (msg.length < 12 || !msg.subarray(0, 8).equals(SIGNATURE)) {
      reply(400, { authenticated: false, reason: 'not an NTLMSSP message' });
      return;
    }
    const type = msg.readUInt32LE(8);
    if (type === 1) {
      const serverChallenge = randomBytes(8);
      challenges.set(req.socket, serverChallenge);
      reply(
        401,
        { authenticated: false, stage: 'challenge' },
        { 'www-authenticate': `NTLM ${type2(serverChallenge)}` }
      );
      return;
    }
    const serverChallenge = type === 3 ? challenges.get(req.socket) : undefined;
    challenges.delete(req.socket);
    if (!serverChallenge) {
      reply(401, {
        authenticated: false,
        reason: 'type 3 on a connection that was never challenged (connection affinity lost)',
      });
      return;
    }
    let result: { ok: boolean; reason?: string };
    try {
      result = verifyType3(msg, serverChallenge);
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : 'malformed type 3' };
    }
    if (!result.ok) {
      reply(401, { authenticated: false, reason: result.reason });
      return;
    }
    reply(200, { authenticated: true, user: NTLM_FIXTURE.username });
  },
};
