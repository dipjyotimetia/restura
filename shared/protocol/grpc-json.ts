/**
 * Parse a gRPC request message typed as JSON without losing 64-bit integer
 * precision.
 *
 * `JSON.parse` turns every number into an IEEE double, so an int64/uint64
 * written as a bare JSON number past `Number.MAX_SAFE_INTEGER` (e.g.
 * `9007199254740993`) is silently rounded before protobuf ever sees it. The
 * proto3 JSON mapping accepts 64-bit integers (and floats) as decimal strings,
 * so integer literals outside the safe range are quoted before parsing — the
 * protobuf JSON decoder then reads the exact digits. Safe integers, fractions,
 * exponents and string contents are left untouched.
 *
 * Shared by the renderer (Electron IPC / Worker proxy / gRPC-Web paths) and the
 * CLI so every harness sends the same value. Throws `SyntaxError` on invalid
 * JSON, exactly like `JSON.parse`.
 */
export function parseGrpcMessageJson(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text));
}

const INTEGER_LITERAL = /-?(?:0|[1-9]\d*)(?![\d.eE])/y;

function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // Skip a string literal (honouring backslash escapes).
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      INTEGER_LITERAL.lastIndex = i;
      const match = INTEGER_LITERAL.exec(text);
      if (match) {
        const literal = match[0];
        if (!Number.isSafeInteger(Number(literal))) {
          out += `${text.slice(last, i)}"${literal}"`;
          last = i + literal.length;
        }
        i += literal.length;
        continue;
      }
      // A fraction / exponent number: skip its remaining number characters.
      while (i < text.length && /[-+\d.eE]/.test(text[i] ?? '')) i++;
      continue;
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}
