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
  assert.deepEqual(verifyToolchain({ nodeVersion: '24.18.1', npmVersion: '12.0.1' }), [
    'Node.js 24.18.0 is required; found 24.18.1.',
    'npm 12.0.2 is required; found 12.0.1.',
  ]);
});
