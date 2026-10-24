/**
 * The one `{{name}}` token grammar for SecretRef-backed (desktop secret)
 * variables, shared by the renderer — which must keep these tokens opaque and
 * detect them (e.g. to defer Basic encoding to main) — and Electron main,
 * which substitutes them at the wire edge. Using one pattern on both sides
 * keeps `{{ name }}` (whitespace-padded) from being treated as opaque by one
 * side and as a plain variable by the other.
 */
const SECRET_VARIABLE_TOKEN_SOURCE = String.raw`\{\{\s*([^{}\s]+)\s*\}\}`;

/** A fresh global matcher (callers must not share `lastIndex` state). */
export function secretVariableTokenPattern(): RegExp {
  return new RegExp(SECRET_VARIABLE_TOKEN_SOURCE, 'g');
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
  return text.replace(secretVariableTokenPattern(), (token, name: string) =>
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
  for (const match of text.matchAll(secretVariableTokenPattern())) {
    if (match[1] !== undefined && isSecret(match[1])) return true;
  }
  return false;
}
