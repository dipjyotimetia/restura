import { describe, expect, it, vi } from 'vitest';

import { verifySignedMacApp } from '../../scripts/verify-electron-signature.mjs';

describe('verifySignedMacApp', () => {
  it('strictly verifies a Developer ID signed bundle', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'Authority=Developer ID Application: Restura' })
      .mockResolvedValueOnce({ stdout: '', stderr: 'valid on disk' });

    await expect(verifySignedMacApp('/tmp/Restura.app', execute)).resolves.toEqual({
      status: 'verified',
    });
    expect(execute).toHaveBeenNthCalledWith(2, 'codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '/tmp/Restura.app',
    ]);
  });

  it('allows an ad-hoc development signature without claiming it is verified', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: 'Signature=adhoc' });

    await expect(verifySignedMacApp('/tmp/Restura.app', execute)).resolves.toEqual({
      status: 'skipped',
      reason: 'ad-hoc signature',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails the build when a real signing identity produces an invalid bundle', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'TeamIdentifier=S7NSMM7XB2' })
      .mockRejectedValueOnce({
        stderr: 'Restura.app: invalid signature (code or signature have been modified)',
      });

    await expect(verifySignedMacApp('/tmp/Restura.app', execute)).rejects.toThrow(
      /invalid signature/
    );
  });
});
