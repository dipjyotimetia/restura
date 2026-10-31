/**
 * The Variable resolver core. Callers supply scopes (highest precedence first)
 * and policy; lookups are own-property only, unknown tokens stay literal, and
 * `{{$helper}}` goes through `applyDynamicVariables`.
 *
 * Two modes, deliberately:
 *  - `resolveVariableText` (CLI): one pass. A user value is never re-expanded,
 *    so a script- or response-set value cannot pull in another variable. The one
 *    exception is documented CLI behaviour: a value of `{{$randomFirstName}}`
 *    still expands, because dynamics run over the substituted result.
 *  - `resolveChainedVariableText` (Environment store): saved environments may
 *    chain values, so tokens inside a value are followed, in a way that does not
 *    depend on definition order.
 */
import { applyDynamicVariables } from './dynamic';
import { replaceVariableTokens } from './tokens';

export type VariableScope = Readonly<Record<string, string>>;

/** How many levels of value-inside-a-value a chain may follow. */
export const MAX_CHAIN_DEPTH = 10;
/** Characters of chained values one expansion may emit, so fan-out cannot hang the app. */
const MAX_CHAINED_CHARS = 16 * 1024 * 1024;

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

/**
 * A scope built from key/value rows: the first definition of a name wins, keys
 * are trimmed the way token names are, blank keys are dropped, and `__proto__`
 * is plain data.
 */
export function createVariableScope(entries: Iterable<readonly [string, string]>): VariableScope {
  const scope: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    const name = key.trim();
    if (name && !Object.hasOwn(scope, name)) scope[name] = value;
  }
  return scope;
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

export interface ChainOptions {
  /**
   * Names a chain must not follow into. They still resolve when written directly
   * in the text. The store uses this for SecretRef-backed variables, whose value
   * is a masked placeholder: a token reached through a chain has to survive so
   * Electron main can materialize it (ADR-0007).
   */
  isOpaque?: (name: string) => boolean;
}

/**
 * Expand tokens, following tokens inside values. The result does not depend on
 * definition order. A cycle stops on the token that closes it, which stays
 * literal, as does anything deeper than {@link MAX_CHAIN_DEPTH} or past the
 * output budget. A scope may own a `$` name; otherwise those tokens are left for
 * the dynamic stage, so a helper in a value is generated exactly once.
 */
export function expandChainedVariables(
  text: string,
  scopes: readonly VariableScope[],
  options: ChainOptions = {}
): string {
  let budget = MAX_CHAINED_CHARS;
  const expand = (input: string, ancestors: readonly string[]): string =>
    replaceVariableTokens(input, (name, raw) => {
      const nested = ancestors.length > 0;
      if (ancestors.includes(name) || ancestors.length >= MAX_CHAIN_DEPTH) return raw;
      if (nested && options.isOpaque?.(name)) return raw;
      const value = lookupVariable(scopes, name);
      if (value === undefined) return raw;
      if (nested) {
        // +1 so a fan-out of empty values still spends budget.
        if (budget <= 0) return raw;
        budget -= value.length + 1;
      }
      return value.includes('{{') ? expand(value, [...ancestors, name]) : value;
    });
  return expand(text, []);
}

/** Chained expansion, then the dynamic helpers exactly once over the result. */
export function resolveChainedVariableText(
  text: string,
  scopes: readonly VariableScope[],
  options: ChainOptions = {}
): string {
  return applyDynamicVariables(expandChainedVariables(text, scopes, options));
}
