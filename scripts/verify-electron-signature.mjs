import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8' });
}

function metadataValue(metadata, key) {
  const prefix = `${key}=`;
  const line = metadata.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/**
 * Verify the on-disk macOS bundle produced by electron-builder. Stable builds
 * require an exact Developer ID team and bundle identity; local and prerelease
 * builds without Apple credentials may retain electron-builder's ad-hoc output.
 */
export async function verifySignedMacApp(appPath, policy = {}, execute = run) {
  const displayed = await execute('codesign', ['-d', '--verbose=4', appPath]);
  const metadata = `${displayed.stdout ?? ''}\n${displayed.stderr ?? ''}`;

  if (/^Signature=adhoc$/m.test(metadata)) {
    if (policy.requireDeveloperId) {
      throw new Error('A Developer ID signature is required for stable macOS releases');
    }
    return { status: 'skipped', reason: 'ad-hoc signature' };
  }

  if (policy.requireDeveloperId) {
    const expectedTeam = policy.expectedTeamIdentifier?.trim();
    const expectedBundle = policy.expectedBundleIdentifier?.trim();
    if (!expectedTeam) {
      throw new Error('Stable macOS verification requires an expected team identifier');
    }
    if (!expectedBundle) {
      throw new Error('Stable macOS verification requires an expected bundle identifier');
    }

    const actualTeam = metadataValue(metadata, 'TeamIdentifier');
    if (actualTeam !== expectedTeam) {
      throw new Error('The macOS signature team does not match the expected Apple team');
    }

    const actualBundle = metadataValue(metadata, 'Identifier');
    if (actualBundle !== expectedBundle) {
      throw new Error('The macOS signature bundle identifier does not match the application');
    }

    const authority = metadataValue(metadata, 'Authority');
    if (
      !authority?.startsWith('Developer ID Application:') ||
      !authority.endsWith(`(${expectedTeam})`)
    ) {
      throw new Error(
        'The macOS signature must use the expected Developer ID Application identity'
      );
    }

    if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(metadata)) {
      throw new Error('The macOS signature must enable the hardened runtime');
    }
  }

  try {
    await execute('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
  } catch (error) {
    const detail = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim();
    throw new Error(
      `macOS code-signature verification failed for ${appPath}${detail ? `:\n${detail}` : ''}`,
      { cause: error }
    );
  }

  return { status: 'verified' };
}

export async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const requireDeveloperId = process.env.RESTURA_REQUIRE_SIGNED_MAC === 'true';
  const expectedTeamIdentifier = process.env.APPLE_TEAM_ID?.trim();

  if (requireDeveloperId && !expectedTeamIdentifier) {
    throw new Error('APPLE_TEAM_ID is required for stable macOS signature verification');
  }

  const result = await verifySignedMacApp(appPath, {
    requireDeveloperId,
    expectedTeamIdentifier,
    expectedBundleIdentifier: context.packager.appInfo.macBundleIdentifier,
  });

  if (result.status === 'skipped') {
    console.warn(`[electron-signature] skipped strict verification: ${result.reason}`);
  } else {
    console.log(`[electron-signature] verified ${appName}`);
  }
}

export default afterSign;
