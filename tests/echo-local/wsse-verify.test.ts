import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { buildWsseHeader, buildWsseDigest } from '@shared/protocol/wsse-header';
import { verifyWsse, TEST_AUTH_FIXTURES } from '../../e2e/mocks/authRoutes';

// Proves the echo server's WSSE verifier matches the client signer
// (shared/protocol/wsse-header.ts) — sign and verify share one definition of
// `digest = base64(sha1(nonce + created + password))`, so a header the client
// produces always round-trips. A verifier that didn't match would give false
// confidence that WSSE signing works.

const { username, password } = TEST_AUTH_FIXTURES.user;
const reqWith = (xwsse: string): IncomingMessage =>
  ({ headers: { 'x-wsse': xwsse } }) as unknown as IncomingMessage;

describe('verifyWsse ↔ client signer', () => {
  it('accepts a deterministic PasswordDigest header from buildWsseDigest', async () => {
    const header = await buildWsseDigest(
      { username, password },
      { nonce: new Uint8Array(16).fill(7), created: '2026-01-01T00:00:00.000Z' }
    );
    expect(verifyWsse(reqWith(header), username, password)).toEqual({ ok: true });
  });

  it('accepts a freshly generated PasswordDigest header (random nonce + timestamp)', async () => {
    const header = await buildWsseHeader({ username, password });
    expect(verifyWsse(reqWith(header), username, password).ok).toBe(true);
  });

  it('accepts the PasswordText form', async () => {
    const header = await buildWsseHeader({ username, password, passwordType: 'PasswordText' });
    expect(verifyWsse(reqWith(header), username, password).ok).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const header = await buildWsseHeader({ username, password });
    expect(verifyWsse(reqWith(header), username, 'not-the-password').ok).toBe(false);
  });

  it('rejects a tampered digest', async () => {
    const header = (await buildWsseHeader({ username, password })).replace(
      /PasswordDigest="[^"]*"/,
      'PasswordDigest="AAAAAAAAAAAAAAAAAAAAAAAAAAA="'
    );
    expect(verifyWsse(reqWith(header), username, password).ok).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWsse(reqWith(''), username, password).ok).toBe(false);
  });
});
