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
    expect(suites.notes).toContain('cancellable run lifecycle');
    expect(suites.notes).toContain('sanitized bounded report persistence');
  });

  it('does not advertise unwired MCP or sandbox runtimes', () => {
    expect(CAPABILITIES['aiLab.agentMcpTools']).toMatchObject({ web: false, desktop: false });
    expect(CAPABILITIES['aiLab.agentSandboxes']).toMatchObject({ web: false, desktop: false });
  });
});
