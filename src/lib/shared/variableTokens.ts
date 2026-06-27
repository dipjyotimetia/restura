/**
 * Canonical `{{var}}` token grammar — covers env-style `{{ name }}` and dynamic
 * `{{ $helper }}` references, with optional surrounding whitespace and
 * dot/dash/underscore in names (matching what the variable resolvers accept).
 *
 * Single source of truth shared by the inline-text highlighter (`VariableText`)
 * and the Monaco decoration scanner (`CodeEditor`), so "gate", "highlight", and
 * "decorate" can never disagree on what counts as a variable.
 */
const TOKEN_SOURCE = '\\{\\{\\s*\\$?[\\w.-]+\\s*\\}\\}';

export interface VariableToken {
  /** Offset of the opening `{{` in the source text. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
  /** Inner variable name, braces stripped and trimmed (e.g. `baseUrl`, `$randomUUID`). */
  name: string;
}

/** Returns every complete `{{var}}` token in `text`, in order of appearance. */
export function findVariableTokens(text: string): VariableToken[] {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const out: VariableToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    out.push({ start: m.index, end: m.index + raw.length, name: raw.slice(2, -2).trim() });
  }
  return out;
}

/** True when `text` contains at least one complete `{{var}}` token. */
export function hasVariableToken(text: string): boolean {
  // Fresh non-global regex per call — a shared /g instance would carry lastIndex.
  return new RegExp(TOKEN_SOURCE).test(text);
}
