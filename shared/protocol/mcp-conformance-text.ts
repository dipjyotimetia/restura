/**
 * Text hygiene for the MCP conformance report (#911). Everything the server
 * sends (names, URIs, error strings) is untrusted: it ends up in Markdown that
 * users paste into issues/PRs and in terminal output, so it is length-bounded,
 * stripped of control characters / ANSI escapes, and scrubbed of the caller's
 * own header values before it is stored in the report.
 */

export const MAX_TEXT = 200;
export const MAX_ERROR_TEXT = 500;
const MIN_SECRET_LENGTH = 8;

// Built from code points so no raw control characters live in the source.
const range = (from: number, to: number) =>
  `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const CONTROL_RE = new RegExp(`[${range(0, 0x1f)}${range(0x7f, 0x9f)}]`, 'g');
const CONTROL_KEEP_LAYOUT_RE = new RegExp(
  `[${range(0, 8)}${range(0x0b, 0x1f)}${range(0x7f, 0x9f)}]`,
  'g'
);
const LINE_SEP_RE = new RegExp(`[\\r\\n${LS}${PS}]+`, 'g');
// ANSI CSI / OSC sequences, removed whole so their payload does not leak as text.
const ANSI_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?)`,
  'g'
);

/** Remove ANSI escapes and control characters; newlines/tabs become one space. */
export function stripControl(text: string): string {
  return text.replace(ANSI_RE, '').replace(LINE_SEP_RE, ' ').replace(CONTROL_RE, '');
}

/** Stripping variant for multi-line documents (keeps \n and \t). */
export function stripControlKeepLayout(text: string): string {
  return text
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(new RegExp(`[${LS}${PS}]`, 'g'), ' ')
    .replace(CONTROL_KEEP_LAYOUT_RE, '');
}

export function clipText(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Replace exact occurrences of caller-supplied secrets (>= 8 chars). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Full pipeline for any server-derived string stored in a report. */
export function sanitizeText(text: string, secrets: readonly string[] = [], max = MAX_TEXT) {
  // Strip control characters BEFORE scrubbing: otherwise a server can echo a
  // secret with an embedded control char, dodge the exact match, and have it
  // reassembled by the strip.
  return clipText(scrubSecrets(stripControl(text), secrets), max);
}

/** Escape Markdown metacharacters in an untrusted inline string. */
export function mdText(text: string): string {
  return clipText(stripControl(text)).replace(/[\\`*_[\]()!<>&|#~]/g, '\\$&');
}

/** Untrusted text inside a code span: backticks cannot be escaped, so replace them. */
export function mdCode(text: string): string {
  return clipText(stripControl(text)).replace(/`/g, "'");
}

/** Stable, non-cryptographic content hash (FNV-1a x2) of canonical JSON, for diffing. */
export function hashJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canon(x)])
      );
    }
    return v;
  };
  const s = JSON.stringify(canon(value)) ?? 'undefined';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
