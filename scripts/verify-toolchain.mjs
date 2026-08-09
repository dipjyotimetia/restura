import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TOOLCHAIN = {
  nodeVersion: '24.18.0',
  npmVersion: '12.0.2',
};

export function verifyToolchain({ nodeVersion, npmVersion }) {
  const errors = [];
  if (nodeVersion !== TOOLCHAIN.nodeVersion) {
    errors.push(`Node.js ${TOOLCHAIN.nodeVersion} is required; found ${nodeVersion}.`);
  }
  if (npmVersion !== TOOLCHAIN.npmVersion) {
    errors.push(`npm ${TOOLCHAIN.npmVersion} is required; found ${npmVersion}.`);
  }
  return errors;
}

export function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * @returns {import('node:child_process').ExecFileSyncOptionsWithStringEncoding}
 */
export function npmCommandOptions(platform = process.platform) {
  return { encoding: 'utf8', ...(platform === 'win32' && { shell: true }) };
}

function installedNpmVersion() {
  return execFileSync(npmExecutable(), ['--version'], npmCommandOptions()).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = verifyToolchain({
    nodeVersion: process.versions.node,
    npmVersion: installedNpmVersion(),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  }
}
