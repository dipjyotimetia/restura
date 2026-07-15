import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities';

describe('storage capability claims', () => {
  it('does not advertise encrypted-at-rest web storage while web uses plaintext IndexedDB', () => {
    expect(CAPABILITIES['storage.encryptedLocal'].web).toBe(false);
    expect(CAPABILITIES['storage.encryptedLocal'].notes).toContain('plaintext IndexedDB');
    expect(CAPABILITIES['storage.osKeychain'].notes).not.toContain('encrypted IndexedDB');
  });
});

describe('AI Lab agent capability claims', () => {
  it('keeps agent suites Electron-only and documents lifecycle/report guarantees', () => {
    const suites = CAPABILITIES['aiLab.agentSuites'];
    expect(suites.web).toBe(false);
    expect(suites.desktop).toBe(true);
    expect(suites.notes).toContain('one cancellable lifecycle per run surface');
    expect(suites.notes).toContain('sanitized bounded report persistence');
  });

  it('advertises wired MCP tools only on desktop and keeps sandboxes unsupported', () => {
    expect(CAPABILITIES['aiLab.agentMcpTools']).toMatchObject({ web: false, desktop: true });
    expect(CAPABILITIES['aiLab.agentSandboxes']).toMatchObject({ web: false, desktop: false });
  });
});
