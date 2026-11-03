import { lookupVariable } from '@shared/variables/resolver';
import { scanVariableTokens } from '@shared/variables/tokens';
import type { LoadedRequest } from '../collectionLoader';
import type { ExecuteOutcome } from './types';

/**
 * The CLI's one rule for variables it cannot resolve on its own: a SecretRef
 * handle, a private variable or a secret (value-less) variable that still has
 * no value — or only an empty one — is never sent as a literal `{{name}}` or an
 * empty string. Every
 * executor calls `unavailableVariableRefusal` before any I/O, so the collection
 * runner, OWS workflows and agent tools share it; the runner also uses it to
 * refuse a whole run up front (private names) and to report a missing secret as
 * a "not sent" item.
 */

type Names = Pick<LoadedRequest, 'privateVariableNames' | 'secretVariableNames'>;

export const HANDLE_REFUSAL =
  'SecretRef handles are unavailable in the CLI; provide the value with --env.';

export function privateVariableRefusalMessage(name: string): string {
  return `Private variable "${name}" is unavailable in the CLI; provide it with --env.`;
}

export function secretVariableRefusalMessage(name: string): string {
  return (
    `not sent: secret variable "${name}" has no value; ` +
    'provide it with --env, --env-var or --data, or set it in an earlier script.'
  );
}

/**
 * The refusal for the first unresolvable variable `item`'s request uses, or
 * undefined when it can be sent. `scope: 'private'` checks handles and private
 * names only (a secret may still be supplied by a row or an earlier script).
 */
export function unavailableVariableRefusal(
  item: Names & { request: unknown },
  vars: Record<string, string>,
  scope: 'all' | 'private' = 'all'
): string | undefined {
  const privateNames = item.privateVariableNames ?? [];
  const secretNames = scope === 'all' ? (item.secretVariableNames ?? []) : [];
  for (const text of stringLeaves(item.request)) {
    if (!text.includes('{{')) continue;
    for (const { name } of scanVariableTokens(text)) {
      if (name.startsWith('$')) continue;
      if (name.startsWith('handle:')) return HANDLE_REFUSAL;
      const isPrivate = privateNames.includes(name);
      const isSecret = !isPrivate && secretNames.includes(name);
      if (!isPrivate && !isSecret) continue;
      // An empty value is missing too: `${CI_TOKEN}` unset must not send "Bearer ".
      const value = lookupVariable([vars], name);
      if (value !== undefined && value !== '') continue;
      return isPrivate ? privateVariableRefusalMessage(name) : secretVariableRefusalMessage(name);
    }
  }
  return undefined;
}

/**
 * An outcome for a request refused before any I/O. `refused` tells the retry
 * policy it is deterministic: retrying it can never succeed.
 */
export function refusedOutcome(errorMessage: string): ExecuteOutcome {
  return { status: 0, passed: false, durationMs: 0, bodyBytes: 0, errorMessage, refused: true };
}

/**
 * The executor preflight: a request blocked at load time or one using a
 * variable the CLI cannot resolve is refused before anything is sent.
 */
export function preflightRefusal(
  item: LoadedRequest,
  vars: Record<string, string>
): ExecuteOutcome | undefined {
  if (item.blocked) return refusedOutcome(item.blocked);
  const message = unavailableVariableRefusal(item, vars);
  return message === undefined ? undefined : refusedOutcome(message);
}

/** Every string in a request, object keys included: a header map can hold a token as a key. */
function* stringLeaves(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const entry of value) yield* stringLeaves(entry);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      yield key;
      yield* stringLeaves(entry);
    }
  }
}
