/**
 * Pretty-print a JSON request body, tolerating `{{var}}` tokens: Postman-style
 * bodies often contain bare tokens (`"id": {{id}}`) that aren't valid JSON.
 * Tokens are swapped for placeholders, the JSON is formatted, and the tokens
 * are put back exactly as written. Returns null if the body isn't JSON.
 */
export function formatJsonBody(text: string, indent = 2): string | null {
  if (!text.trim()) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    // fall through to the token-tolerant pass
  }

  const tokens: string[] = [];
  const bare = new Set<number>();
  let protectedText = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        const n = tokens.push(text.slice(i, end + 2)) - 1;
        if (inString) protectedText += `__RESTURA_VAR_${n}__`;
        else {
          bare.add(n);
          protectedText += `"__RESTURA_VAR_${n}__"`;
        }
        i = end + 1;
        continue;
      }
    }
    if (ch === '"' && !isEscaped(text, i)) inString = !inString;
    protectedText += ch;
  }
  if (tokens.length === 0) return null;

  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(protectedText), null, indent);
  } catch {
    return null;
  }
  return formatted.replace(/"?__RESTURA_VAR_(\d+)__"?/g, (match, n: string) => {
    const index = Number(n);
    const token = tokens[index] ?? match;
    // A bare token was wrapped in quotes we added; an in-string one keeps the
    // string's own quotes, which sit outside this match.
    if (bare.has(index)) return token;
    const lead = match.startsWith('"') ? '"' : '';
    const tail = match.endsWith('"') && match.length > 1 ? '"' : '';
    return `${lead}${token}${tail}`;
  });
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}
