import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8' });
}

export function parseCliPolicy(args) {
  const [appPath, ...options] = args;
  if (!appPath || appPath.startsWith('--')) {
    throw new Error('A macOS app path is required');
  }

  const policy = {
    requireDeveloperId: false,
    expectedTeamIdentifier: undefined,
    expectedBundleIdentifier: undefined,
  };

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    switch (option) {
      case '--require-developer-id':
        policy.requireDeveloperId = true;
        break;
      case '--team-id':
        index += 1;
        policy.expectedTeamIdentifier = options[index];
        if (!policy.expectedTeamIdentifier) throw new Error('--team-id requires a value');
        break;
      case '--bundle-id':
        index += 1;
        policy.expectedBundleIdentifier = options[index];
        if (!policy.expectedBundleIdentifier) throw new Error('--bundle-id requires a value');
        break;
      default:
        throw new Error(`Unknown argument: ${option}`);
    }
  }

  if (policy.requireDeveloperId && !policy.expectedTeamIdentifier) {
    throw new Error('--team-id is required with --require-developer-id');
  }

  return { appPath, policy };
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

async function main() {
  const { appPath, policy } = parseCliPolicy(process.argv.slice(2));
  const result = await verifySignedMacApp(appPath, policy);
  console.log(`[electron-signature] ${result.status}`);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[electron-signature] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export default afterSign;
