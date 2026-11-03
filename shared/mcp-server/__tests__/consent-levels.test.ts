import { describe, expect, it } from 'vitest';
import {
  canCreateCollection,
  canCreateEnvironment,
  canEdit,
  canEditEnvironment,
  canExecute,
  canExecuteWithEnvironment,
  canRead,
  canReadEnvironment,
  DEFAULT_CONSENT,
  McpServerConsentSchema,
  setCollectionConsent,
  setEnvironmentConsent,
  setEnvironmentExecutable,
} from '../consent';
import { DEFAULT_MCP_SERVER_SETTINGS, McpServerSettingsCatchSchema } from '../settings';

describe('collection consent levels', () => {
  it.each([
    ['hidden', false, false, false],
    ['read-only', true, false, false],
    ['edit', true, true, false],
    ['full', true, true, true],
  ] as const)('%s → read=%s edit=%s execute=%s', (level, read, edit, execute) => {
    const consent = setCollectionConsent(DEFAULT_CONSENT, 'c1', level);
    expect(canRead(consent, 'c1')).toBe(read);
    expect(canEdit(consent, 'c1')).toBe(edit);
    expect(canExecute(consent, 'c1')).toBe(execute);
    // Never leaks to other collections.
    expect(canRead(consent, 'c2')).toBe(false);
  });

  it('creating a collection needs an edit grant somewhere', () => {
    expect(canCreateCollection(DEFAULT_CONSENT)).toBe(false);
    expect(canCreateCollection(setCollectionConsent(DEFAULT_CONSENT, 'c', 'read-only'))).toBe(
      false
    );
    expect(canCreateCollection(setCollectionConsent(DEFAULT_CONSENT, 'c', 'edit'))).toBe(true);
    expect(canCreateCollection({ ...DEFAULT_CONSENT, defaultLevel: 'full' })).toBe(true);
  });
});

describe('environment consent levels', () => {
  it('edit implies read; read-only does not imply edit', () => {
    const ro = setEnvironmentConsent(DEFAULT_CONSENT, 'e', 'read-only');
    expect(canReadEnvironment(ro, 'e')).toBe(true);
    expect(canEditEnvironment(ro, 'e')).toBe(false);
    const ed = setEnvironmentConsent(DEFAULT_CONSENT, 'e', 'edit');
    expect(canReadEnvironment(ed, 'e')).toBe(true);
    expect(canEditEnvironment(ed, 'e')).toBe(true);
    expect(canCreateEnvironment(ed)).toBe(true);
    expect(canCreateEnvironment(ro)).toBe(false);
  });

  it('execute-with-environment is a separate per-environment opt-in', () => {
    const ed = setEnvironmentConsent(DEFAULT_CONSENT, 'e', 'edit');
    expect(canExecuteWithEnvironment(ed, 'e')).toBe(false);
    const ex = setEnvironmentExecutable(ed, 'e', true);
    expect(canExecuteWithEnvironment(ex, 'e')).toBe(true);
    expect(canExecuteWithEnvironment(ex, 'other')).toBe(false);
    expect(canExecuteWithEnvironment(setEnvironmentExecutable(ex, 'e', false), 'e')).toBe(false);
    // No environment: only globals + collection vars — covered by collection `full`.
    expect(canExecuteWithEnvironment(DEFAULT_CONSENT, null)).toBe(true);
  });

  it('old persisted consent (no edit / execute fields) still parses', () => {
    const legacy = {
      defaultLevel: 'read-only',
      perCollection: { a: 'full' },
      environmentsDefaultLevel: 'read-only',
      perEnvironment: {},
      historyLevel: 'hidden',
    };
    expect(McpServerConsentSchema.safeParse(legacy).success).toBe(true);
  });
});

describe('server settings rehydrate', () => {
  it('a corrupt blob falls back per field, consent fails closed', () => {
    const parsed = McpServerSettingsCatchSchema.parse({
      enabled: 'yes',
      approvalMode: 'yolo',
      consent: { defaultLevel: 'everything' },
      redactResponseBodies: 0,
      preferredPort: 80,
    });
    expect(parsed).toEqual({
      enabled: false,
      approvalMode: 'ask-every-change',
      consent: DEFAULT_CONSENT,
      redactResponseBodies: true,
      preferredPort: undefined,
    });
  });

  it('defaults are off, ask-every-change, everything hidden, redaction on', () => {
    expect(DEFAULT_MCP_SERVER_SETTINGS).toEqual({
      enabled: false,
      approvalMode: 'ask-every-change',
      consent: DEFAULT_CONSENT,
      redactResponseBodies: true,
    });
  });
});
