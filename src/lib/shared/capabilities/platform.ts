// Capability rows: Secure storage and native OS integration.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const PLATFORM_CAPABILITIES = {
  'storage.osKeychain': {
    label: 'OS keychain (safeStorage) for secrets',
    web: false,
    desktop: true,
    notes: 'Web has no OS keychain; its default IndexedDB persistence is plaintext',
  },
  'storage.encryptedLocal': {
    label: 'Encrypted local storage',
    web: false,
    desktop: true,
    notes:
      'Desktop persistence uses safeStorage; web currently uses plaintext IndexedDB because the optional session-passphrase UI has not shipped',
  },
  'storage.externalSecrets': {
    label:
      'External cloud secret references (AWS Secrets Manager, Google Secret Manager, Azure Key Vault)',
    web: false,
    desktop: true,
    notes:
      'Desktop resolves references in the main process from profiles under Settings → Secrets (identity locations only; provider credentials stay with the provider SDK). The CLI resolves them with --external-secrets-config; web has no resolver',
  },
  'native.shell': { label: 'Native shell.openExternal', web: false, desktop: true },
  'native.notifications': { label: 'Native OS notifications', web: false, desktop: true },
  'native.tray': { label: 'System tray icon', web: false, desktop: true },
} as const satisfies Record<string, CapabilityRow>;
