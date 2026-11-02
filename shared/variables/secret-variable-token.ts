/**
 * Token handling for SecretRef-backed (desktop secret) variables, shared by the
 * renderer — which must keep these tokens opaque and detect them (e.g. to defer
 * Basic encoding to main) — and Electron main, which substitutes them at the
 * wire edge. Both read the core grammar in `./tokens`, so a token the resolver
 * would consume (`{{my secret}}`, `{{ name }}`) can never be opaque on one side
 * and a plain variable on the other.
 */
import { replaceVariableTokens, scanVariableTokens } from './tokens';

/**
 * A send refused because a secret-variable token did not come from the field
 * itself. The message names variables and the field, never a value.
 */
export class SecretVariableReferenceError extends Error {
  readonly variable: string;

  constructor(
    source: string,
    variable: string,
    field?: string,
    rule = 'Secret variables can only be used where they are written.'
  ) {
    super(
      `${source} references secret variable "${variable}"${field ? ` in ${field}` : ''}. ${rule}`
    );
    this.name = 'SecretVariableReferenceError';
    this.variable = variable;
  }
}

/**
 * Replace every token whose name passes `isSecret` with `replacer(name, token)`;
 * other tokens are left untouched. Own-property semantics are the caller's
 * concern (pass a predicate built from `Object.hasOwn`).
 */
export function replaceSecretVariableTokenMatches(
  text: string,
  isSecret: (name: string) => boolean,
  replacer: (name: string, token: string) => string
): string {
  return replaceVariableTokens(text, (name, token) =>
    isSecret(name) ? replacer(name, token) : token
  );
}

/**
 * True when a Basic credential still carries an opaque secret-variable token
 * (the renderer must then defer encoding to main). Tolerates a malformed
 * block (hand-edited import) with a missing username / password.
 */
export function basicAuthReferencesSecretVariable(
  basic: { username?: unknown; password?: unknown } | undefined,
  isSecret: (name: string) => boolean
): boolean {
  if (!basic) return false;
  const password = basic.password as { kind?: unknown; value?: unknown } | string | undefined;
  const texts = [
    typeof basic.username === 'string' ? basic.username : '',
    typeof password === 'string'
      ? password
      : password?.kind === 'inline' && typeof password.value === 'string'
        ? password.value
        : '',
  ];
  return texts.some((text) => referencesSecretVariable(text, isSecret));
}

/** True when `text` contains a token for any of the given secret-variable names. */
export function referencesSecretVariable(
  text: string,
  isSecret: (name: string) => boolean
): boolean {
  return scanVariableTokens(text).some((token) => isSecret(token.name));
}
