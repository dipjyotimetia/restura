/**
 * Protocol-agnostic string variable substitution.
 *
 * Primitive used by every ProtocolModule.injectVariables implementation
 * and by the DAG executor wherever a {{var}} reference might appear in a
 * non-request context (e.g. forEach collectionExpression, setVariable
 * valueExpression).
 *
 * Variable keys are regex-escaped before being compiled into the matcher
 * so that keys containing metacharacters (rare but valid) don't blow up
 * the replacement.
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

export function injectString(text: string, variables: Record<string, string>): string {
  if (!text) return text;
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    const escaped = key.replace(REGEX_META, '\\$&');
    // Use a function replacer so `$`-sequences in the *value* (e.g. `$&`, `$1`,
    // `$$`, `` $` ``) are inserted verbatim rather than interpreted as
    // String.replace replacement patterns.
    result = result.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'), () => value);
  }
  return result;
}
