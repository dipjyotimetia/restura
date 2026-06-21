/**
 * Color + cursor helpers shared by the terminal reporters.
 *
 * Honours the NO_COLOR convention (https://no-color.org), suppresses ANSI when
 * stdout is not a TTY (piped to a file / CI log) so reports don't carry raw
 * escape codes, and lets FORCE_COLOR override both. Extracted from the live
 * reporter so every reporter styles output the same way.
 */
export const colorEnabled =
  process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'
    ? true
    : Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

/**
 * True when stdout is an interactive terminal we may take over with cursor
 * control (the live dashboard). Piped output, CI logs, and NO_COLOR all resolve
 * to false, falling back to plain line output.
 */
export const interactive = Boolean(process.stdout.isTTY) && colorEnabled;

// Proper open/close SGR pairs (not a blanket reset) so styles nest correctly —
// e.g. bold(cyan(x)) closes the inner color with 39 and the outer weight with 22.
const sgr =
  (open: number, close: number) =>
  (s: string | number): string =>
    colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const color = {
  green: sgr(32, 39),
  red: sgr(31, 39),
  yellow: sgr(33, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
};

/** Hide the cursor while a live region is being re-rendered (TTY only). */
export function hideCursor(): void {
  if (interactive) process.stdout.write('\x1b[?25l');
}

/** Restore the cursor. Safe to call unconditionally; no-op when not interactive. */
export function showCursor(): void {
  if (interactive) process.stdout.write('\x1b[?25h');
}
