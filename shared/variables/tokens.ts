/**
 * The one `{{name}}` token grammar. A name is one or more characters excluding
 * `{` and `}`, trimmed of surrounding whitespace, and holds no line break, so
 * `{{my key}}`, `{{a:b}}` and `{{ $helper }}` are all tokens while `{{ }}` and a
 * multi-line block are not. Resolvers, the highlighter,
 * the Monaco scanner and the secret matcher (renderer and Electron main) all
 * read tokens through this module, so what is highlighted, what is sent and what
 * stays opaque cannot disagree.
 *
 * Kept free of the faker-backed dynamic helpers so Electron main can import it.
 *
 * Linear on adversarial input: the name class cannot cross a brace, so a failed
 * attempt never rescans past the next `{`. Do not add `\s*` around a lazy name,
 * which backtracks quadratically on a long whitespace run; trim in code instead.
 */
const TOKEN_SOURCE = String.raw`\{\{([^{}]+)\}\}`;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const PLAIN_NAME = /^\$?[\w.-]+$/;

/**
 * True for a name that reads as a variable reference rather than template or
 * JSON-ish text (`{{#if a}}`, `{{ u | upper }}`, `{{"k":1}}`). The grammar accepts
 * those so a variable may be named anything; an UNKNOWN token is only worth
 * reporting as unresolved when its name also passes here. Display only: what is
 * sent does not depend on it.
 */
export function isPlainVariableName(name: string): boolean {
  return PLAIN_NAME.test(name);
}

export interface VariableToken {
  /** Offset of the opening `{{` in the source text. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
  /** Inner variable name, trimmed (e.g. `baseUrl`, `my key`, `$randomUUID`). */
  name: string;
}

function* iterateTokens(text: string): Generator<VariableToken> {
  // A fresh matcher per scan: callers never share `lastIndex` state.
  for (const match of text.matchAll(new RegExp(TOKEN_SOURCE, 'g'))) {
    const name = (match[1] as string).trim();
    // Checked after the match rather than in the pattern, which stays linear.
    if (name && !LINE_BREAK.test(name))
      yield { start: match.index, end: match.index + match[0].length, name };
  }
}

/** Every complete token in `text`, in order of appearance. */
export function scanVariableTokens(text: string): VariableToken[] {
  return [...iterateTokens(text)];
}

/** True when `text` contains at least one complete token. */
export function hasVariableToken(text: string): boolean {
  return !iterateTokens(text).next().done;
}

/**
 * Single left-to-right pass: each token is replaced by what `replacer` returns,
 * taken literally (no `$&`-style patterns), and the output is never rescanned.
 * `raw` is the token's original text, for a replacer that keeps it.
 */
export function replaceVariableTokens(
  text: string,
  replacer: (name: string, raw: string) => string
): string {
  let out = '';
  let cursor = 0;
  for (const { start, end, name } of iterateTokens(text)) {
    out += text.slice(cursor, start) + replacer(name, text.slice(start, end));
    cursor = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
