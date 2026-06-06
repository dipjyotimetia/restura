import type { AuthConfig } from '@/types';

/**
 * Secret-bearing fields per `AuthConfig` block — the single source of truth
 * for every redactor that strips credential material before it crosses a
 * leakage boundary. Imported by:
 *  - `src/lib/shared/collection-secret-redaction.ts` (renderer export flow)
 *  - `electron/main/collection-export-redactor.ts` (file-collection writes)
 *
 * When adding an auth method, add its secret fields HERE — both redactors
 * pick the change up automatically. A field missed here is a plaintext
 * credential in an exported file.
 *
 * Runtime-import-free (the `AuthConfig` import is type-only), so the Electron
 * main process can consume it without pulling renderer code into its bundle.
 */
export const SECRET_FIELDS_BY_AUTH_BLOCK = {
  basic: ['password'],
  bearer: ['token'],
  apiKey: ['value'],
  oauth2: ['accessToken', 'refreshToken', 'clientSecret', 'password'],
  digest: ['password'],
  awsSignature: ['secretKey'],
  oauth1: ['consumerSecret', 'accessToken', 'accessTokenSecret'],
  ntlm: ['password'],
  wsse: ['password'],
} as const satisfies Partial<Record<keyof AuthConfig, readonly string[]>>;
