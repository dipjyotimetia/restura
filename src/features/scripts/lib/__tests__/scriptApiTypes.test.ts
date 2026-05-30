import { describe, it, expect } from 'vitest';
import { SCRIPT_API_DTS } from '../scriptApiTypes';

/**
 * Guards the Monaco IntelliSense type stub for the script sandbox.
 *
 * Two invariants matter:
 *  1. The stub must stay a plain *ambient script* — a single top-level
 *     `import`/`export` turns it into a module, at which point every
 *     `declare const` stops being a global and completions silently vanish.
 *  2. It must keep documenting the reference-panel surface (the `rs.*` snippets
 *     listed in ScriptsEditor's PRE_REQUEST_API / TEST_API), so editor
 *     autocomplete and the docs panel don't drift apart unnoticed.
 */
describe('SCRIPT_API_DTS', () => {
  it('declares the sandbox globals as ambient top-level consts (not window members)', () => {
    for (const name of ['rs', 'pm', 'request', 'response', 'environment', 'globals']) {
      expect(SCRIPT_API_DTS).toContain(`declare const ${name}:`);
    }
    expect(SCRIPT_API_DTS).not.toContain('interface Window');
  });

  it('stays a non-module ambient script (no top-level import/export)', () => {
    // Top-level only — JSDoc/comment text and `export`-free member lines are fine.
    const topLevelModuleSyntax = /^\s*(import|export)\b/m;
    expect(topLevelModuleSyntax.test(SCRIPT_API_DTS)).toBe(false);
  });

  it('documents the reference-panel API surface', () => {
    // Mirrors ScriptsEditor's PRE_REQUEST_API / TEST_API snippet lists.
    const members = [
      'variables',
      'request',
      'response',
      'test',
      'expect',
      'json',
      'time',
      'headers',
      'url',
    ];
    for (const member of members) {
      expect(SCRIPT_API_DTS).toContain(member);
    }
  });

  it('documents the richer runtime surface from scriptExecutor', () => {
    for (const member of [
      'collectionVariables',
      'iterationData',
      'cookies',
      'vault',
      'execution',
      'sendRequest',
      'visualizer',
      'info',
    ]) {
      expect(SCRIPT_API_DTS).toContain(member);
    }
  });
});
