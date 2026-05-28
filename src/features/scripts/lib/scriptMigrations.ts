/**
 * Pre-request / test script namespace migration between Postman's `pm.*`
 * and Restura's native `rs.*` sandbox namespace.
 *
 * `rs` is the native namespace; `pm` is kept as a live alias to the same
 * sandbox object (see scriptExecutor.ts), so migration is a normalization --
 * un-migrated `pm.*` still runs. We migrate anyway so imported Postman
 * collections present as native `rs.*`, and reverse on export so the output
 * runs in Postman itself.
 *
 * Safety: only a top-level `pm`/`rs` identifier immediately followed by `.`
 * is rewritten. Before rewriting we mask string literals, comments, and
 * regex literals so their contents are never touched -- a URL like
 * `https://pm.example.com` in a string, a `// pm.test` comment, or a regex
 * `/pm.test/` are all left intact. `npm`/`spm`/`foo.pm.bar` in code are
 * excluded by the identifier-boundary rules below.
 *
 * Known limitation: `pm.*` / `rs.*` inside a template-literal interpolation
 * (`${pm.variables.get('x')}`) is masked with the rest of the template and is
 * NOT rewritten. At runtime the `pm` alias keeps such scripts working.
 */

// Strings (single/double/back-quoted, with escapes), line comments, block comments.
const LITERALS_AND_COMMENTS = /(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// JS regex literals, but only where a `/` legitimately starts a regex -- i.e.
// in expression position, preceded by start-of-line or a token that cannot end
// an expression. This avoids masking a division operator (e.g. `total / pm.x`),
// so `pm.x` there is still migrated. Applied AFTER strings/comments are masked.
const REGEX_LITERAL = new RegExp(
  '(?<=(?:^|[-+=(,:;[{}!&|?*/%^~<>]|\\breturn|\\btypeof|\\bcase|\\bdo|\\belse|\\bvoid|\\bdelete|\\bin|\\bof|\\byield)\\s*)' +
    '\\/(?:\\\\.|\\[(?:\\\\.|[^\\]\\r\\n])*\\]|[^/\\r\\n\\\\])+\\/[a-z]*',
  'gm'
);

// Private-use delimiters around the stash index. Built from char codes so the
// source stays pure ASCII; they are not word characters and, being delimited,
// cannot collide with real numeric literals in the surrounding code.
const MASK_OPEN = String.fromCharCode(0xe000);
const MASK_CLOSE = String.fromCharCode(0xe001);
const RESTORE_RE = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g');

function rewriteNamespace(code: string, from: 'pm' | 'rs', to: 'pm' | 'rs'): string {
  if (!code) return code;

  // Mask spans we must not rewrite, with restorable, delimited sentinels.
  const stash: string[] = [];
  const stashMatch = (match: string): string => {
    const token = `${MASK_OPEN}${stash.length}${MASK_CLOSE}`;
    stash.push(match);
    return token;
  };
  const masked = code.replace(LITERALS_AND_COMMENTS, stashMatch).replace(REGEX_LITERAL, stashMatch);

  // Negative lookbehind rejects a preceding identifier char, `$`, or `.` so
  // `npm.`, `spm.`, and member access like `foo.pm.bar` are not matched.
  // Lookahead requires the identifier to be followed by `.` (optionally spaced).
  const re = new RegExp(`(?<![$\\w.])${from}(?=\\s*\\.)`, 'g');
  const rewritten = masked.replace(re, to);

  return rewritten.replace(RESTORE_RE, (_, i) => stash[Number(i)] ?? '');
}

/** Forward migration for Postman IMPORT: `pm.*` -> `rs.*`. */
export function migrateScriptPmToRs(scriptText: string): string {
  return rewriteNamespace(scriptText, 'pm', 'rs');
}

/** Reverse migration for Postman EXPORT: `rs.*` -> `pm.*`. */
export function migrateScriptRsToPm(scriptText: string): string {
  return rewriteNamespace(scriptText, 'rs', 'pm');
}
