import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatusPath } from '../.codex/hooks/_shared.mjs';
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
    expect(
      validationDecision({ dirty: false, signature: 'a', previous: null, passed: false })
    ).toBeNull();
  });

  it('does not block a passing validation', () => {
    expect(
      validationDecision({ dirty: true, signature: 'a', previous: null, passed: true })
    ).toBeNull();
  });

  it('uses the current Codex stop contract for a new failure', () => {
    expect(
      validationDecision({ dirty: true, signature: 'a', previous: null, passed: false })
    ).toEqual({
      continue: false,
      stopReason:
        'Restura validation is not green. Fix the reported npm run validate failure before stopping.',
    });
  });

  it('does not block twice for an unchanged failure', () => {
    expect(
      validationDecision({
        dirty: true,
        signature: 'a',
        previous: { signature: 'a', passed: false },
        passed: false,
      })
    ).toBeNull();
  });
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
});
