import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  parseStatusPath,
  signatureFromDetails,
  statePath,
  treeSignature,
} from '../.codex/hooks/_shared.mjs';
import { validationDecision } from '../.codex/hooks/stop-policy.mjs';

const repoRoot = resolve(process.cwd());
const hooksDir = resolve(repoRoot, '.codex/hooks');

function runHook(name: string, payload: unknown) {
  return spawnSync(process.execPath, [resolve(hooksDir, name)], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });
}

describe('Codex generated-file guard', () => {
  it('blocks a generated file named directly', () => {
    const result = runHook('guard-generated-files.mjs', {
      cwd: repoRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { file_path: resolve(repoRoot, 'docs/CAPABILITY_MATRIX.md') },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('src/lib/shared/capabilities.ts');
    expect(result.stdout).toBe('');
  });

  it('blocks a generated path embedded in apply_patch input', () => {
    const result = runHook('guard-generated-files.mjs', {
      cwd: repoRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        patch:
          '*** Begin Patch\n*** Update File: src/lib/opencollection/spec-types.ts\n@@\n-x\n+y\n*** End Patch',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('gen:opencollection-types');
    expect(result.stdout).toBe('');
  });

  it('allows ordinary source edits', () => {
    const result = runHook('guard-generated-files.mjs', {
      cwd: repoRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { file_path: resolve(repoRoot, 'src/lib/shared/release-notes.ts') },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });
});

describe('Codex stop policy', () => {
  it('preserves porcelain status prefixes while extracting changed paths', () => {
    expect(parseStatusPath(' M src/lib/shared/release-notes.ts')).toBe(
      'src/lib/shared/release-notes.ts'
    );
    expect(parseStatusPath('R  old-name.ts -> new-name.ts')).toBe('new-name.ts');
  });

  it('does not validate a clean tree', () => {
    expect(validationDecision({ dirty: false, signature: 'a', previous: null })).toBeNull();
  });

  it('accepts only a matching explicit validation success', () => {
    expect(
      validationDecision({
        dirty: true,
        signature: 'a',
        previous: { signature: 'a', passed: true },
      })
    ).toBeNull();
  });

  it('uses the current Codex stop contract when evidence is absent or stale', () => {
    expect(validationDecision({ dirty: true, signature: 'a', previous: null })).toEqual({
      continue: false,
      stopReason:
        'Restura validation evidence is missing or stale. Run npm run validate explicitly before stopping.',
    });
  });

  it('continues to block an unchanged explicit failure', () => {
    expect(
      validationDecision({
        dirty: true,
        signature: 'a',
        previous: { signature: 'a', passed: false },
      })
    ).not.toBeNull();
  });

  it('fails closed when validation evidence cannot be inspected', () => {
    const result = runHook('stop-checks.mjs', { cwd: tmpdir(), hook_event_name: 'Stop' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      continue: false,
    });
    expect(result.stdout).toContain('could not be verified');
  });

  it('fingerprints file content rather than size and mtime metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'restura-hook-fingerprint-'));
    const file = join(directory, 'same-size.txt');
    try {
      writeFileSync(file, 'first');
      const before = statSync(file);
      const first = contentFingerprint('same-size.txt', directory);
      writeFileSync(file, 'other');
      utimesSync(file, before.atime, before.mtime);
      const second = contentFingerprint('same-size.txt', directory);
      expect(second).not.toBe(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds validation evidence to the checked-out commit', () => {
    const details = ['src/example.ts:33188:content'];
    expect(signatureFromDetails('a'.repeat(40), details)).not.toBe(
      signatureFromDetails('b'.repeat(40), details)
    );
  });

  it('stores bounded state inside the writable ignored worktree directory', () => {
    expect(statePath('stop-checks.json', repoRoot)).toBe(
      resolve(repoRoot, '.codex/metrics/stop-checks.json')
    );
  });

  it('detects content changes inside an untracked directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'restura-hook-untracked-'));
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: directory }).status).toBe(0);
      expect(
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory }).status
      ).toBe(0);
      expect(spawnSync('git', ['config', 'user.name', 'Test'], { cwd: directory }).status).toBe(0);
      writeFileSync(join(directory, 'tracked.txt'), 'tracked');
      expect(spawnSync('git', ['add', 'tracked.txt'], { cwd: directory }).status).toBe(0);
      expect(spawnSync('git', ['commit', '-qm', 'test'], { cwd: directory }).status).toBe(0);

      const nested = join(directory, 'nested');
      mkdirSync(nested);
      writeFileSync(join(nested, 'new-file.ts'), 'first');
      const first = treeSignature(directory);
      writeFileSync(join(nested, 'new-file.ts'), 'other');
      const second = treeSignature(directory);

      expect(first.dirty).toBe(true);
      expect(second.signature).not.toBe(first.signature);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('Codex hook configuration', () => {
  it('uses supported matchers, root-resolved commands, and bounded timeouts', () => {
    const hooks = readFileSync(resolve(repoRoot, '.codex/hooks.json'), 'utf8');
    const config = JSON.parse(hooks) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

    expect(hooks).toContain('Edit|Write');
    expect(hooks).toContain('git rev-parse --show-toplevel');
    expect(hooks).not.toContain('"matcher": "Skill"');
    expect(hooks).not.toContain('"decision": "block"');
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PostToolUse).toHaveLength(1);
    expect(config.hooks.PreCompact).toHaveLength(1);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('never auto-executes mutable workspace validation or format binaries', () => {
    const stop = readFileSync(resolve(hooksDir, 'stop-checks.mjs'), 'utf8');
    const format = readFileSync(resolve(hooksDir, 'format-edit.mjs'), 'utf8');
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(stop).not.toContain('spawnSync');
    expect(stop).not.toContain("['run', 'validate']");
    expect(format).not.toContain('node_modules/.bin/biome');
    expect(packageJson.scripts.validate).toBe('node scripts/ci/run-validation.mjs');
    expect(packageJson.scripts['validate:checks']).toContain('npm run test:ci');
  });
});
