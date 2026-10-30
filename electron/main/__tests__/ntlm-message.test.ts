// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createType1Message,
  createType3Message,
  md4,
  ntowfv2,
  parseType2Message,
  selectNtlmChallenge,
} from '../handlers/ntlm-message';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('md4 (RFC 1320 §A.5 test suite)', () => {
  it.each([
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      'e33b4ddc9c38f2199c3e7b164fcc0536',
    ],
  ])('md4(%j)', (input, expected) => {
    expect(hex(md4(Buffer.from(input, 'latin1')))).toBe(expected);
  });
});

// MS-NLMP §4.2.4 (NTLMv2 Authentication) worked example.
const SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex');
const CLIENT_CHALLENGE = Buffer.from('aaaaaaaaaaaaaaaa', 'hex');
// MsvAvNbDomainName "Domain", MsvAvNbComputerName "Server", MsvAvEOL.
const TARGET_INFO = Buffer.from(
  '02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000',
  'hex'
);

function challengeMessage(flags: number, targetInfo: Buffer): string {
  const header = Buffer.alloc(48);
  header.write('NTLMSSP\0', 0, 'latin1');
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(flags >>> 0, 20);
  SERVER_CHALLENGE.copy(header, 24);
  header.writeUInt16LE(targetInfo.length, 40);
  header.writeUInt16LE(targetInfo.length, 42);
  header.writeUInt32LE(48, 44);
  return Buffer.concat([header, targetInfo]).toString('base64');
}

function readField(msg: Buffer, at: number): Buffer {
  const len = msg.readUInt16LE(at);
  const off = msg.readUInt32LE(at + 4);
  return msg.subarray(off, off + len);
}

describe('NTLMv2 (MS-NLMP §4.2.4 vectors)', () => {
  it('NTOWFv2', () => {
    expect(hex(ntowfv2('User', 'Password', 'Domain'))).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });

  it('type 3 carries the spec LMv2 and NTProofStr', () => {
    const challenge = parseType2Message(challengeMessage(0xe28a8233, TARGET_INFO));
    expect(hex(challenge.serverChallenge)).toBe('0123456789abcdef');
    const msg = Buffer.from(
      createType3Message(
        challenge,
        { username: 'User', password: 'Password', domain: 'Domain', workstation: 'COMPUTER' },
        { clientChallenge: CLIENT_CHALLENGE, timestamp: 0n }
      ),
      'base64'
    );
    expect(msg.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0');
    expect(msg.readUInt32LE(8)).toBe(3);
    expect(hex(readField(msg, 12))).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
    expect(hex(readField(msg, 20).subarray(0, 16))).toBe('68cd0ab851e51c96aabc927bebef6a1c');
    expect(readField(msg, 28).toString('utf16le')).toBe('Domain');
    expect(readField(msg, 36).toString('utf16le')).toBe('User');
    expect(readField(msg, 44).toString('utf16le')).toBe('COMPUTER');
    // No key exchange / signing is negotiated by an HTTP-only client.
    expect(msg.readUInt32LE(60) & 0x40000030).toBe(0);
  });

  it('never puts the password on the wire, in any encoding', () => {
    const password = 'S3cret-Pa55word';
    const challenge = parseType2Message(challengeMessage(0xe28a8233, TARGET_INFO));
    const msg = Buffer.from(
      createType3Message(challenge, { username: 'User', password, domain: 'Domain' }),
      'base64'
    );
    for (const enc of ['utf16le', 'latin1', 'utf8'] as const) {
      expect(msg.includes(Buffer.from(password, enc))).toBe(false);
    }
  });

  it('splits DOMAIN\\user when no explicit domain is set', () => {
    const challenge = parseType2Message(challengeMessage(0xe28a8233, TARGET_INFO));
    const msg = Buffer.from(
      createType3Message(challenge, { username: 'CORP\\alice', password: 'x' }),
      'base64'
    );
    expect(readField(msg, 28).toString('utf16le')).toBe('CORP');
    expect(readField(msg, 36).toString('utf16le')).toBe('alice');
  });

  it('uses the server timestamp and a zero LMv2 response when MsvAvTimestamp is present', () => {
    const ts = Buffer.from('0090d336b734c301', 'hex');
    const withTs = Buffer.concat([
      TARGET_INFO.subarray(0, TARGET_INFO.length - 4),
      Buffer.from([7, 0, 8, 0]),
      ts,
      Buffer.from([0, 0, 0, 0]),
    ]);
    const challenge = parseType2Message(challengeMessage(0xe28a8233, withTs));
    const msg = Buffer.from(
      createType3Message(challenge, { username: 'User', password: 'Password' }),
      'base64'
    );
    expect(hex(readField(msg, 12))).toBe('00'.repeat(24));
    // NTLMv2 client blob: 16-byte proof, 8 header bytes, then the timestamp.
    expect(hex(readField(msg, 20).subarray(24, 32))).toBe(hex(ts));
  });
});

describe('type 1 / challenge selection', () => {
  it('type 1 is a 32-byte NEGOTIATE with no domain or workstation payload', () => {
    const msg = Buffer.from(createType1Message(), 'base64');
    expect(msg.length).toBe(32);
    expect(msg.readUInt32LE(8)).toBe(1);
    expect(msg.readUInt16LE(16)).toBe(0);
    expect(msg.readUInt16LE(24)).toBe(0);
  });

  it('selects the NTLM token among several schemes', () => {
    expect(selectNtlmChallenge(['Negotiate', 'NTLM TlRMTVNTUAACAAAA'])).toBe('TlRMTVNTUAACAAAA');
    expect(selectNtlmChallenge(['Basic realm="x", NTLM abc='])).toBe('abc=');
    expect(selectNtlmChallenge(['NTLM'])).toBeNull();
    expect(selectNtlmChallenge(['Negotiate abc='])).toBeNull();
  });

  it('rejects a non-type-2 or out-of-bounds challenge', () => {
    expect(() => parseType2Message(createType1Message())).toThrow(/type 2/);
    const bad = Buffer.from(challengeMessage(0, TARGET_INFO), 'base64');
    bad.writeUInt32LE(9999, 44);
    expect(() => parseType2Message(bad.toString('base64'))).toThrow(/out of bounds/);
  });
});
