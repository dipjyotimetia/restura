// Reformat JSON text without rounding integers beyond 2^53.
//
// JSON.parse → JSON.stringify silently rounds integer literals such as
// 9007199254740993 or Snowflake ids. These helpers re-print JSON with the
// original digits of every such literal, using JSON.parse source-text access
// (`context.source`, ES2025; available in every runtime Restura ships). Where
// that is unavailable they leave the text untouched rather than round it.
// Runtime-neutral: used by the Electron main process and the renderer.

const UNSAFE_INT = /^-?\d+$/;
// A sentinel no JSON string produced by JSON.stringify can contain unescaped.
const MARK = '\u0000lossless-int:';

function supportsSourceAccess(): boolean {
  let seen = false;
  JSON.parse('1', (_k, v, context?: { source?: string }) => {
    seen = context?.source === '1';
    return v;
  });
  return seen;
}

let sourceAccess: boolean | undefined;

function hasUnsafeIntegers(text: string): boolean {
  // Cheap pre-check: any run of 16+ digits might exceed 2^53.
  return /\d{16,}/.test(text);
}

/**
 * Re-print JSON text with `indent` (0 = compact), keeping integer literals
 * beyond 2^53 exactly. Throws if `text` is not JSON. Returns the input
 * unchanged when exact digits could not be preserved.
 */
export function reformatJsonLossless(text: string, indent = 0): string {
  if (!hasUnsafeIntegers(text)) return JSON.stringify(JSON.parse(text), null, indent);
  sourceAccess ??= supportsSourceAccess();
  if (!sourceAccess) {
    JSON.parse(text); // still validate
    return text;
  }
  const parsed = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    typeof context?.source === 'string' &&
    UNSAFE_INT.test(context.source)
      ? `${MARK}${context.source}`
      : value
  );
  return JSON.stringify(parsed, null, indent).replace(
    /"\\u0000lossless-int:(-?\d+)"/g,
    (_m, digits: string) => digits
  );
}

/** True when JSON.parse(text) would round an integer literal. */
export function jsonLosesPrecision(text: string): boolean {
  if (!hasUnsafeIntegers(text)) return false;
  let lossy = false;
  try {
    JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === 'number' &&
        !Number.isSafeInteger(value) &&
        (context?.source === undefined || UNSAFE_INT.test(context.source))
      ) {
        lossy = true;
      }
      return value;
    });
  } catch {
    return false;
  }
  return lossy;
}
