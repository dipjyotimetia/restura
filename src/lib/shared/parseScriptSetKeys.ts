/**
 * Statically extract the variable NAMES a pre-request script sets, so the
 * `{{var}}` validator can treat them as known instead of flagging a false
 * positive. A variable set at runtime (`pm.environment.set('token', ...)`)
 * resolves correctly on the wire but is invisible to a static scope scan — this
 * recovers the common literal-key case.
 *
 * Matches both the `pm.*` and `rs.*` script namespaces and all four scopes
 * (environment / variables / globals / collectionVariables), with single, double,
 * or backtick quotes. Non-literal keys (a variable or template expression as the
 * first arg) intentionally do not match and stay flagged.
 */
const SET_KEY_RE =
  /(?:pm|rs)\.(?:environment|variables|globals|collectionVariables)\.set\(\s*(['"`])([^'"`]+)\1/g;

export function parseScriptSetKeys(script?: string | null): string[] {
  if (!script) return [];
  const keys = new Set<string>();
  SET_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SET_KEY_RE.exec(script)) !== null) {
    // A backtick key containing `${...}` is a dynamic template, not a literal.
    if (m[2] && !m[2].includes('${')) keys.add(m[2]);
  }
  return [...keys];
}
