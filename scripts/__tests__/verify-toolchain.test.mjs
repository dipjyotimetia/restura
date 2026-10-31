import assert from 'node:assert/strict';
import test from 'node:test';
import {
  npmCommandOptions,
  npmExecutable,
  TOOLCHAIN,
  verifyToolchain,
} from '../verify-toolchain.mjs';

test('uses the Windows npm command shim when required', () => {
  assert.equal(npmExecutable('win32'), 'npm.cmd');
  assert.equal(npmExecutable('linux'), 'npm');
});

test('runs the Windows npm command through a shell', () => {
  assert.deepEqual(npmCommandOptions('win32'), { encoding: 'utf8', shell: true });
  assert.deepEqual(npmCommandOptions('linux'), { encoding: 'utf8' });
});

test('accepts the pinned Node and npm versions', () => {
  assert.deepEqual(verifyToolchain(TOOLCHAIN), []);
});

test('reports each mismatched tool separately', () => {
  assert.deepEqual(verifyToolchain({ nodeVersion: '0.0.1', npmVersion: '0.0.2' }), [
    `Node.js ${TOOLCHAIN.nodeVersion} is required; found 0.0.1.`,
    `npm ${TOOLCHAIN.npmVersion} is required; found 0.0.2.`,
  ]);
});
