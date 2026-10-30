// NTLM (MS-NLMP) message codec — NTLMv2 only.
//
// NTLM authenticates a CONNECTION, not a request: the client sends a
// NEGOTIATE (type 1) message, the server answers 401 with a CHALLENGE
// (type 2) carrying a server nonce, and the client answers on the SAME socket
// with an AUTHENTICATE (type 3) message whose NTLMv2 response is an HMAC over
// that nonce. The type 1 message carries no credentials; the password never
// goes on the wire in any form, only the HMAC proof.
//
// Desktop-only (#1069): the handshake needs connection affinity that only the
// Electron fetcher can guarantee (see ntlm-handshake.ts), so this stays in
// Electron main rather than `shared/`. MD4 is implemented here because
// OpenSSL 3 (and so `crypto.createHash('md4')`) no longer ships it by default.

import { createHmac, randomBytes } from 'node:crypto';

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

// NegotiateFlags (MS-NLMP §2.2.2.5).
const NEGOTIATE_UNICODE = 0x00000001;
const NEGOTIATE_OEM = 0x00000002;
const REQUEST_TARGET = 0x00000004;
const NEGOTIATE_SIGN = 0x00000010;
const NEGOTIATE_SEAL = 0x00000020;
const NEGOTIATE_NTLM = 0x00000200;
const NEGOTIATE_ALWAYS_SIGN = 0x00008000;
const NEGOTIATE_EXTENDED_SESSIONSECURITY = 0x00080000;
const NEGOTIATE_VERSION = 0x02000000;
const NEGOTIATE_128 = 0x20000000;
const NEGOTIATE_KEY_EXCH = 0x40000000;
const NEGOTIATE_56 = 0x80000000;

const NEGOTIATE_FLAGS =
  (NEGOTIATE_UNICODE |
    NEGOTIATE_OEM |
    REQUEST_TARGET |
    NEGOTIATE_NTLM |
    NEGOTIATE_ALWAYS_SIGN |
    NEGOTIATE_EXTENDED_SESSIONSECURITY |
    NEGOTIATE_128 |
    NEGOTIATE_56) >>>
  0;

/** AV_PAIR id carrying the server's FILETIME (MS-NLMP §2.2.2.1). */
const MSV_AV_EOL = 0;
const MSV_AV_TIMESTAMP = 7;

/** Milliseconds between the FILETIME epoch (1601-01-01) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

export interface NtlmCredentials {
  username: string;
  password: string;
  domain?: string;
  workstation?: string;
}

export interface NtlmChallenge {
  flags: number;
  serverChallenge: Buffer;
  targetInfo: Buffer;
}

export interface NtlmType3Options {
  /** Fixed 8-byte client challenge — tests only; defaults to random. */
  clientChallenge?: Buffer;
  /** Fixed FILETIME (100 ns ticks since 1601) — tests only; defaults to the server's or now. */
  timestamp?: bigint;
}

// ---------------------------------------------------------------------------
// MD4 (RFC 1320)
// ---------------------------------------------------------------------------

export function md4(input: Uint8Array): Buffer {
  const bitLen = input.length * 8;
  const padded = Buffer.alloc((((input.length + 8) >> 6) + 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  padded.writeUInt32LE(bitLen >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rotl = (x: number, s: number) => (x << s) | (x >>> (32 - s));
  const x = new Array<number>(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const r1 = (p: number, q: number, r: number, s: number, k: number, sh: number) =>
      rotl((p + ((q & r) | (~q & s)) + x[k]!) | 0, sh);
    const r2 = (p: number, q: number, r: number, s: number, k: number, sh: number) =>
      rotl((p + ((q & r) | (q & s) | (r & s)) + x[k]! + 0x5a827999) | 0, sh);
    const r3 = (p: number, q: number, r: number, s: number, k: number, sh: number) =>
      rotl((p + (q ^ r ^ s) + x[k]! + 0x6ed9eba1) | 0, sh);
    for (const k of [0, 4, 8, 12]) {
      a = r1(a, b, c, d, k, 3);
      d = r1(d, a, b, c, k + 1, 7);
      c = r1(c, d, a, b, k + 2, 11);
      b = r1(b, c, d, a, k + 3, 19);
    }
    for (const k of [0, 1, 2, 3]) {
      a = r2(a, b, c, d, k, 3);
      d = r2(d, a, b, c, k + 4, 5);
      c = r2(c, d, a, b, k + 8, 9);
      b = r2(b, c, d, a, k + 12, 13);
    }
    for (const k of [0, 2, 1, 3]) {
      a = r3(a, b, c, d, k, 3);
      d = r3(d, a, b, c, k + 8, 9);
      c = r3(c, d, a, b, k + 4, 11);
      b = r3(b, c, d, a, k + 12, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }

  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0);
  out.writeInt32LE(b, 4);
  out.writeInt32LE(c, 8);
  out.writeInt32LE(d, 12);
  return out;
}

// ---------------------------------------------------------------------------
// NTLMv2 primitives (MS-NLMP §3.3.2)
// ---------------------------------------------------------------------------

// HMAC-MD5 (and MD4 above) are mandated by MS-NLMP: the server recomputes
// exactly these bytes, so no stronger algorithm can be substituted without
// breaking NTLM. MD5 is used as a keyed MAC over a fresh server challenge,
// not to store or protect the password at rest. The protocol's real weakness
// (offline cracking of a captured NTLMv2 response) is documented in ADR 0036
// and the auth guide recommends https: for NTLM upstreams.
function hmacMd5(key: Uint8Array, ...data: Uint8Array[]): Buffer {
  const h = createHmac('md5', key);
  for (const d of data) h.update(d);
  return h.digest();
}

/** NTOWFv2 = HMAC_MD5(MD4(UNICODE(password)), UNICODE(UPPER(user) + domain)). */
export function ntowfv2(username: string, password: string, domain: string): Buffer {
  const ntHash = md4(Buffer.from(password, 'utf16le'));
  return hmacMd5(ntHash, Buffer.from(username.toUpperCase() + domain, 'utf16le'));
}

/** Split `DOMAIN\user` when no explicit domain is configured. */
function splitDomain(creds: NtlmCredentials): { username: string; domain: string } {
  const domain = creds.domain?.trim() ?? '';
  if (!domain) {
    const slash = creds.username.indexOf('\\');
    if (slash > 0) {
      return { domain: creds.username.slice(0, slash), username: creds.username.slice(slash + 1) };
    }
  }
  return { username: creds.username, domain };
}

function findAvPair(targetInfo: Buffer, id: number): Buffer | undefined {
  let off = 0;
  while (off + 4 <= targetInfo.length) {
    const avId = targetInfo.readUInt16LE(off);
    const len = targetInfo.readUInt16LE(off + 2);
    if (avId === MSV_AV_EOL || off + 4 + len > targetInfo.length) return undefined;
    if (avId === id) return targetInfo.subarray(off + 4, off + 4 + len);
    off += 4 + len;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** NEGOTIATE_MESSAGE (type 1), base64. Carries flags only — no credentials. */
export function createType1Message(): string {
  const msg = Buffer.alloc(32);
  SIGNATURE.copy(msg, 0);
  msg.writeUInt32LE(1, 8);
  msg.writeUInt32LE(NEGOTIATE_FLAGS, 12);
  // Empty DomainNameFields / WorkstationFields, payload offset = 32.
  msg.writeUInt32LE(32, 20);
  msg.writeUInt32LE(32, 28);
  return msg.toString('base64');
}

function readSecurityBuffer(msg: Buffer, at: number, what: string): Buffer {
  if (at + 8 > msg.length) throw new Error(`NTLM challenge truncated (${what})`);
  const len = msg.readUInt16LE(at);
  const offset = msg.readUInt32LE(at + 4);
  if (offset + len > msg.length) throw new Error(`NTLM challenge ${what} out of bounds`);
  return msg.subarray(offset, offset + len);
}

/** Parse a base64 CHALLENGE_MESSAGE (type 2). Throws on a malformed message. */
export function parseType2Message(base64: string): NtlmChallenge {
  const msg = Buffer.from(base64, 'base64');
  if (msg.length < 32 || !msg.subarray(0, 8).equals(SIGNATURE) || msg.readUInt32LE(8) !== 2) {
    throw new Error('Malformed NTLM challenge (not a type 2 message)');
  }
  const flags = msg.readUInt32LE(20);
  const serverChallenge = Buffer.from(msg.subarray(24, 32));
  // TargetInfoFields exist from offset 40 when the message is long enough.
  const targetInfo =
    msg.length >= 48 ? readSecurityBuffer(msg, 40, 'target info') : Buffer.alloc(0);
  return { flags, serverChallenge, targetInfo: Buffer.from(targetInfo) };
}

/**
 * The base64 type 2 token from a 401's `WWW-Authenticate` values, or null when
 * the server sent no NTLM challenge with a token (e.g. a bare `NTLM` offer, or
 * only other schemes).
 */
export function selectNtlmChallenge(values: readonly string[]): string | null {
  for (const header of values) {
    for (const part of header.split(',')) {
      const m = /^\s*NTLM\s+([A-Za-z0-9+/]+=*)\s*$/i.exec(part);
      if (m) return m[1]!;
    }
  }
  return null;
}

/**
 * AUTHENTICATE_MESSAGE (type 3), base64, answering `challenge` with an NTLMv2
 * response. Only HMAC proofs are emitted; the password is used solely as MD4
 * key material.
 */
export function createType3Message(
  challenge: NtlmChallenge,
  creds: NtlmCredentials,
  options: NtlmType3Options = {}
): string {
  const { username, domain } = splitDomain(creds);
  const unicode = (challenge.flags & NEGOTIATE_UNICODE) !== 0;
  const encode = (s: string) => Buffer.from(s, unicode ? 'utf16le' : 'latin1');

  const clientChallenge = options.clientChallenge ?? randomBytes(8);
  const serverTimestamp = findAvPair(challenge.targetInfo, MSV_AV_TIMESTAMP);
  const timestamp = Buffer.alloc(8);
  if (options.timestamp !== undefined) {
    timestamp.writeBigUInt64LE(options.timestamp);
  } else if (serverTimestamp?.length === 8) {
    serverTimestamp.copy(timestamp);
  } else {
    timestamp.writeBigUInt64LE((BigInt(Date.now()) + FILETIME_EPOCH_OFFSET_MS) * 10_000n);
  }

  const key = ntowfv2(username, creds.password, domain);
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    challenge.targetInfo,
    Buffer.alloc(4),
  ]);
  const ntProof = hmacMd5(key, challenge.serverChallenge, temp);
  const ntResponse = Buffer.concat([ntProof, temp]);
  // With a server timestamp the LMv2 response MUST be Z(24) (MS-NLMP §3.1.5.1.2).
  const lmResponse = serverTimestamp
    ? Buffer.alloc(24)
    : Buffer.concat([hmacMd5(key, challenge.serverChallenge, clientChallenge), clientChallenge]);

  const flags =
    (challenge.flags &
      ~(NEGOTIATE_KEY_EXCH | NEGOTIATE_SIGN | NEGOTIATE_SEAL | NEGOTIATE_VERSION) &
      ~(unicode ? NEGOTIATE_OEM : NEGOTIATE_UNICODE)) >>>
    0;

  const payloads = [
    lmResponse,
    ntResponse,
    encode(domain),
    encode(username),
    encode(creds.workstation ?? ''),
    Buffer.alloc(0), // EncryptedRandomSessionKey — no key exchange
  ];
  const HEADER = 64;
  const header = Buffer.alloc(HEADER);
  SIGNATURE.copy(header, 0);
  header.writeUInt32LE(3, 8);
  let offset = HEADER;
  payloads.forEach((p, i) => {
    const at = 12 + i * 8;
    header.writeUInt16LE(p.length, at);
    header.writeUInt16LE(p.length, at + 2);
    header.writeUInt32LE(offset, at + 4);
    offset += p.length;
  });
  header.writeUInt32LE(flags, 60);
  return Buffer.concat([header, ...payloads]).toString('base64');
}
