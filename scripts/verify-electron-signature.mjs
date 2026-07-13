import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8' });
}

/**
 * Fail closed when electron-builder claims to have signed a macOS bundle with
 * a real identity but the resulting code signature is not valid on disk.
 * Ad-hoc signatures are permitted for local/CI builds without Apple secrets.
 */
export async function verifySignedMacApp(appPath, execute = run) {
  const displayed = await execute('codesign', ['-d', '--verbose=4', appPath]);
  const metadata = `${displayed.stdout ?? ''}\n${displayed.stderr ?? ''}`;

  if (/^Signature=adhoc$/m.test(metadata)) {
    return { status: 'skipped', reason: 'ad-hoc signature' };
  }

  try {
    await execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
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
  const result = await verifySignedMacApp(appPath);

  if (result.status === 'skipped') {
    console.warn(`[electron-signature] skipped strict verification: ${result.reason}`);
  } else {
    console.log(`[electron-signature] verified ${appName}`);
  }
}

export default afterSign;
