/**
 * The Variable resolver core. Callers supply scopes and policy; lookups are
 * own-property only, unknown tokens stay literal, and `{{$helper}}` goes through
 * `applyDynamicVariables`.
 *
 * Two modes, deliberately:
 *  - `resolveVariableText` (CLI, and streaming's equivalent): one pass. A user
 *    value is never re-expanded. The one exception is documented CLI behaviour: a
 *    value of `{{$randomFirstName}}` still expands, because dynamics run over the
 *    substituted result.
 *  - `expandVariablesInOrder` (the app's HTTP request scope and the Environment
 *    store): one pass per variable, in definition order, as the app has always
 *    done. A value can only pull in a variable defined after it, so the result
 *    depends on the order, and a cycle ends when the walk does.
 *
 * A secret variable resolves only from a token written in the original text
 * (ADR-0007): `shieldVariableTokens` renames those tokens before the walk, so an
 * entry for that name matches them and never a token a value brought in.
 */
import { applyDynamicVariables } from './dynamic';
import { replaceVariableTokens } from './tokens';

export type VariableScope = Readonly<Record<string, string>>;

/** The value of `name` in the first scope that owns it. Inherited members never match. */
export function lookupVariable(scopes: readonly VariableScope[], name: string): string | undefined {
  for (const scope of scopes) {
    if (!Object.hasOwn(scope, name)) continue;
    const value: unknown = scope[name];
    // Collections loaded from YAML can carry numbers and booleans.
    return value === undefined || value === null ? undefined : String(value);
  }
  return undefined;
}

export interface SubstituteOptions {
  /**
   * Policy hook, called once per non-dynamic token before it is substituted.
   * Throw to refuse the request (the CLI does for handles and private names).
   */
  onToken?: (name: string, found: boolean) => void;
}

/** One pass over `text`. `$` names are left for the dynamic stage. */
export function substituteVariables(
  text: string,
  scopes: readonly VariableScope[],
  options: SubstituteOptions = {}
): string {
  return replaceVariableTokens(text, (name, raw) => {
    if (name.startsWith('$')) return raw;
    const value = lookupVariable(scopes, name);
    options.onToken?.(name, value !== undefined);
    return value ?? raw;
  });
}

/** One pass of user variables, then the dynamic helpers over the result. */
export function resolveVariableText(
  text: string,
  scopes: readonly VariableScope[],
  options: SubstituteOptions = {}
): string {
  return applyDynamicVariables(substituteVariables(text, scopes, options));
}

export interface ShieldedToken {
  name: string;
  /** The token as written, padding included. */
  raw: string;
}

export interface TokenShield {
  /** The text with each matching token renamed to its marker. */
  text: string;
  /** Marker name to the token it stands for. */
  tokens: ReadonlyMap<string, ShieldedToken>;
}

export interface ExpandOptions {
  /** Names that substitute only from a token already in `text`, never one a value brought in. */
  directOnly?: (name: string) => boolean;
}

function markerNonce(): string {
  // getRandomValues, not randomUUID, which a plain-http self-hosted page lacks.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Rename the tokens in `text` that `isShielded` accepts. The marker holds a nonce
 * drawn per call, so no variable value can spell one, and stays a valid token, so
 * a walk can substitute it.
 */
export function shieldVariableTokens(
  text: string,
  isShielded: (name: string) => boolean
): TokenShield {
  const tokens = new Map<string, ShieldedToken>();
  let nonce: string | undefined;
  const shielded = replaceVariableTokens(text, (name, raw) => {
    if (!isShielded(name)) return raw;
    nonce ??= markerNonce();
    const marker = `__restura_secret_${nonce}_${tokens.size}__`;
    tokens.set(marker, { name, raw });
    return `{{${marker}}}`;
  });
  return { text: shielded, tokens };
}

/**
 * `entries` for a walk over shielded text: an entry named by `isShielded` matches
 * only that name's markers, at the same position in the order.
 */
export function shieldedEntries(
  entries: Iterable<readonly [string, string]>,
  shield: TokenShield,
  isShielded: (name: string) => boolean
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [key, value] of entries) {
    const name = key.trim();
    if (!isShielded(name)) {
      out.push([key, value]);
      continue;
    }
    for (const [marker, token] of shield.tokens) {
      if (token.name === name) out.push([marker, value]);
    }
  }
  return out;
}

/** Put back every marker a walk left, as written unless `restore` says otherwise. */
export function restoreShieldedTokens(
  text: string,
  shield: TokenShield,
  restore: (token: ShieldedToken) => string = (token) => token.raw
): string {
  if (shield.tokens.size === 0) return text;
  return replaceVariableTokens(text, (name, raw) => {
    const token = shield.tokens.get(name);
    return token ? restore(token) : raw;
  });
}

/**
 * Walk `entries` in the order given, replacing the tokens named by each key once
 * over the text so far. A later key sees what an earlier value brought in; an
 * earlier key never does. Keys match the way token names do (trimmed), so a blank
 * key is inert; values are literal, and dynamics are left for the caller to run
 * once at the end.
 *
 * Growth is unbudgeted, as it always was: a fan-out across many variables hits the
 * engine's string length limit and throws, which fails that one send.
 */
export function expandVariablesInOrder(
  text: string,
  entries: Iterable<readonly [string, string]>,
  options: ExpandOptions = {}
): string {
  const { directOnly } = options;
  if (directOnly) {
    const shield = shieldVariableTokens(text, directOnly);
    const walked = expandVariablesInOrder(
      shield.text,
      shieldedEntries(entries, shield, directOnly)
    );
    return restoreShieldedTokens(walked, shield);
  }
  let result = text;
  for (const [key, value] of entries) {
    if (!result.includes('{{')) return result;
    const name = key.trim();
    // Collections loaded from YAML can carry numbers and booleans.
    if (!name || value === undefined || value === null) continue;
    const literal = String(value);
    result = replaceVariableTokens(result, (token, raw) => (token === name ? literal : raw));
  }
  return result;
}
