import { describe, expect, it, vi } from 'vitest';

import { parseCliPolicy, verifySignedMacApp } from '../../scripts/verify-electron-signature.mjs';

const requiredPolicy = {
  requireDeveloperId: true,
  expectedTeamIdentifier: 'S7NSMM7XB2',
  expectedBundleIdentifier: 'com.dipjyotimetia.restura',
};

const signedMetadata = [
  'Identifier=com.dipjyotimetia.restura',
  'CodeDirectory v=20500 size=504 flags=0x10000(runtime) hashes=4+7 location=embedded',
  'Authority=Developer ID Application: Dipjyoti Metia (S7NSMM7XB2)',
  'TeamIdentifier=S7NSMM7XB2',
].join('\n');

function validSignatureExecutor(metadata = signedMetadata) {
  return vi
    .fn()
    .mockResolvedValueOnce({ stdout: '', stderr: metadata })
    .mockResolvedValueOnce({ stdout: '', stderr: 'valid on disk' });
}

describe('verifySignedMacApp', () => {
  it('strictly verifies the expected Developer ID signed bundle', async () => {
    const execute = validSignatureExecutor();

    await expect(verifySignedMacApp('/tmp/Restura.app', requiredPolicy, execute)).resolves.toEqual({
      status: 'verified',
    });
    expect(execute).toHaveBeenNthCalledWith(2, 'codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=4',
      '/tmp/Restura.app',
    ]);
  });

  it('allows an ad-hoc development signature without claiming it is verified', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: 'Signature=adhoc' });

    await expect(verifySignedMacApp('/tmp/Restura.app', {}, execute)).resolves.toEqual({
      status: 'skipped',
      reason: 'ad-hoc signature',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an ad-hoc signature when Developer ID is required', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: 'Signature=adhoc' });

    await expect(verifySignedMacApp('/tmp/Restura.app', requiredPolicy, execute)).rejects.toThrow(
      /Developer ID signature is required/
    );
  });

  it.each([
    [
      'team',
      signedMetadata.replace('TeamIdentifier=S7NSMM7XB2', 'TeamIdentifier=OTHERTEAM'),
      /team/i,
    ],
    [
      'bundle identifier',
      signedMetadata.replace(
        'Identifier=com.dipjyotimetia.restura',
        'Identifier=com.example.untrusted'
      ),
      /bundle identifier/i,
    ],
    [
      'hardened runtime',
      signedMetadata.replace('flags=0x10000(runtime)', 'flags=0x0(none)'),
      /hardened runtime/i,
    ],
    [
      'Developer ID authority',
      signedMetadata.replace(
        'Authority=Developer ID Application: Dipjyoti Metia (S7NSMM7XB2)',
        'Authority=Apple Development: Dipjyoti Metia (S7NSMM7XB2)'
      ),
      /Developer ID Application/i,
    ],
  ])('rejects a mismatched %s', async (_label, metadata, expectedError) => {
    const execute = validSignatureExecutor(metadata);

    await expect(verifySignedMacApp('/tmp/Restura.app', requiredPolicy, execute)).rejects.toThrow(
      expectedError
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('requires the expected team and bundle identifier for stable verification', async () => {
    const execute = validSignatureExecutor();

    await expect(
      verifySignedMacApp('/tmp/Restura.app', { requireDeveloperId: true }, execute)
    ).rejects.toThrow(/expected team identifier/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails the build when a matching signing identity produces an invalid bundle', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: signedMetadata })
      .mockRejectedValueOnce({
        stderr: 'Restura.app: invalid signature (code or signature have been modified)',
      });

    await expect(verifySignedMacApp('/tmp/Restura.app', requiredPolicy, execute)).rejects.toThrow(
      /invalid signature/
    );
  });
});

describe('parseCliPolicy', () => {
  it('parses a required Developer ID artifact policy', () => {
    expect(
      parseCliPolicy([
        '/tmp/Restura.app',
        '--require-developer-id',
        '--team-id',
        'S7NSMM7XB2',
        '--bundle-id',
        'com.dipjyotimetia.restura',
      ])
    ).toEqual({
      appPath: '/tmp/Restura.app',
      policy: {
        requireDeveloperId: true,
        expectedTeamIdentifier: 'S7NSMM7XB2',
        expectedBundleIdentifier: 'com.dipjyotimetia.restura',
      },
    });
  });

  it('rejects a missing app path', () => {
    expect(() => parseCliPolicy([])).toThrow(/app path/i);
  });

  it('rejects a required Developer ID policy without a team', () => {
    expect(() => parseCliPolicy(['/tmp/Restura.app', '--require-developer-id'])).toThrow(/team/i);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseCliPolicy(['/tmp/Restura.app', '--unsafe-skip-verification'])).toThrow(
      /unknown argument/i
    );
  });
});
