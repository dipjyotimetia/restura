/**
 * The single source of truth for exact header / query-param names that always
 * carry a credential. Shared by the two security predicates that must not drift:
 *  - `shared/protocol/ai/redaction.ts` — scrubs request context before it goes
 *    to an AI provider.
 *  - `src/lib/shared/keyvalue-secret-redaction.ts` — blanks secret rows before a
 *    collection is exported / written to disk.
 *
 * A credential header added here is covered by BOTH surfaces. Each consumer
 * layers its own extras (regexes, segment rules) on top of this base.
 */
export const CREDENTIAL_HEADER_NAMES: readonly string[] = [
  'authorization',
  'authentication',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-amz-security-token',
  'x-functions-key',
  'api-key',
  'apikey',
  'api_key',
  'private-token',
];
