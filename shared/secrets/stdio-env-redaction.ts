import { isSecretFieldName } from './key-value-redaction';
import { isSecretHandle, redactSecret, type SecretValue, unwrapSecret } from './secret-ref';

/**
 * MCP stdio launch env rows (`McpRequest.stdio.env`) before a collection is
 * exported, written to a git-backed folder, or shared (ADR 0007, ADR 0030).
 *
 * - A plain value is blanked (and the row flagged `secret`) when the row is
 *   already flagged secret or its NAME looks like a credential.
 * - A `secretRef` keeps handle references (opaque ids) and blanks inline
 *   plaintext, exactly like auth fields.
 *
 * Non-secret rows (LOG_LEVEL, PATH, …) pass through so the launch still
 * round-trips; the recipient re-enters the credentials.
 */

export interface StdioEnvRow {
  key: string;
  value: string;
  secret?: boolean;
  secretRef?: SecretValue;
}

function plainIsSecret(row: StdioEnvRow): boolean {
  return row.secret === true || isSecretFieldName(row.key);
}

export function redactStdioEnvRows<T extends StdioEnvRow>(rows: readonly T[]): T[] {
  return rows.map((row) => {
    let next = row;
    if (plainIsSecret(row) && row.value !== '') next = { ...next, value: '', secret: true };
    if (row.secretRef !== undefined && !isSecretHandle(row.secretRef)) {
      next = { ...next, secretRef: redactSecret(row.secretRef) };
    }
    return next;
  });
}

/** Count rows that still carry plaintext credential material. */
export function countStdioEnvInlineSecrets(rows: readonly StdioEnvRow[] | undefined): number {
  if (!rows) return 0;
  let count = 0;
  for (const row of rows) {
    if (plainIsSecret(row) && row.value !== '') count++;
    const ref = row.secretRef;
    if (typeof ref === 'string' ? ref !== '' : ref?.kind === 'inline' && unwrapSecret(ref) !== '') {
      count++;
    }
  }
  return count;
}

/**
 * The same policy for the OpenCollection wire shape (`{ name, value, secret?,
 * secretRef? }`) inside cached `_oc` passthrough bags, so a re-export of an
 * imported item cannot replay plaintext from its original file.
 */
export function redactOcStdioEnv(env: readonly unknown[]): unknown[] {
  return env.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : typeof e.key === 'string' ? e.key : '';
    const next: Record<string, unknown> = { ...e };
    if (
      typeof e.value === 'string' &&
      e.value !== '' &&
      (e.secret === true || isSecretFieldName(name))
    ) {
      next.value = '';
      next.secret = true;
    }
    if (e.secretRef !== undefined && !isSecretHandle(e.secretRef as SecretValue)) {
      delete next.secretRef;
    }
    return next;
  });
}

/** The `stdio.env` rows of an untyped request object, if any. */
export function stdioEnvOf(request: Record<string, unknown>): StdioEnvRow[] | undefined {
  const stdio = request.stdio;
  if (!stdio || typeof stdio !== 'object') return undefined;
  const env = (stdio as { env?: unknown }).env;
  return Array.isArray(env) ? (env as StdioEnvRow[]) : undefined;
}
