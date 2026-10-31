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
  entries: Iterable<readonly [string, string]>
): string {
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
