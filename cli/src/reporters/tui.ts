import logUpdate from 'log-update';
import type { Reporter, RunResult, RequestRunResult, RunMeta } from './types.js';
import type { LoadedRequest } from '../runner/collectionLoader.js';
import { color, interactive, hideCursor, showCursor } from '../ui/colors.js';
import { methodOf, formatRequestLine, formatSummaryLine } from './format.js';

/**
 * Live terminal dashboard for interactive runs — a bordered box that re-renders
 * in place as each request completes, with a spinner on the in-flight request
 * and a progress bar. Used as the default `restura run` reporter in a TTY; piped
 * output and CI fall back to the line-based {@link LiveReporter}.
 *
 * Rendering is split into a pure {@link renderFrame} (unit-tested) and this thin
 * imperative shell that owns the spinner timer, cursor, and SIGINT cleanup.
 */

export type RowOutcome = 'running' | 'pass' | 'fail' | 'error';

export interface TuiRow {
  method: string;
  name: string;
  outcome: RowOutcome;
  /** HTTP/gRPC status code; absent for the running row. */
  status?: number;
  durationMs?: number;
}

export interface TuiState {
  collectionName: string;
  /** Estimated total requests (filtered × iterations) for the progress bar. */
  total?: number;
  /** Completed requests, in finish order. */
  rows: TuiRow[];
  /** The request currently in flight, if any. */
  current?: TuiRow;
  spinnerFrame: number;
  done: boolean;
}

export interface RenderOpts {
  /** Total terminal width (columns). */
  width: number;
  /** Max rows of request history to show before scrolling. */
  maxRows: number;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' };
const METHOD_W = 6;
const MIN_WIDTH = 24;
// Row content before the name: icon (1) + space (1) + padded method + space (1).
const ROW_PREFIX = 1 + 1 + METHOD_W + 1;

type SettledOutcome = Exclude<RowOutcome, 'running'>;

/** The colour for a settled outcome — green pass / yellow error / red fail. */
const colorForOutcome = (o: SettledOutcome): ((s: string | number) => string) =>
  o === 'pass' ? color.green : o === 'error' ? color.yellow : color.red;

/** Truncate to `max` visible chars with a trailing ellipsis. */
function clamp(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return max > 1 ? `${s.slice(0, max - 1)}…` : '…';
}

function icon(outcome: RowOutcome, spinnerFrame: number): string {
  if (outcome === 'running') return color.cyan(SPINNER[spinnerFrame % SPINNER.length]!);
  return colorForOutcome(outcome)(outcome === 'pass' ? '✓' : '✗');
}

/** Right-hand status + duration cell, returned as plain text + coloured text. */
function statusCell(row: TuiRow): { plain: string; colored: string } {
  if (row.outcome === 'running') return { plain: '…', colored: color.dim('…') };
  const code = row.status && row.status > 0 ? String(row.status) : '—';
  const dur = row.durationMs !== undefined ? `${row.durationMs}ms` : '';
  const plain = dur ? `${code} ${dur}` : code;
  const codeColored = colorForOutcome(row.outcome)(code);
  const colored = dur ? `${codeColored} ${color.dim(dur)}` : codeColored;
  return { plain, colored };
}

/** Render a single request row: `icon method name … status` filling the width. */
function rowLine(row: TuiRow, spinnerFrame: number, width: number): string {
  const inner = width - 4; // content width between "│ " and " │"
  const { plain: rPlain, colored: rColored } = statusCell(row);
  const nameBudget = inner - ROW_PREFIX - rPlain.length - 1; // 1 = min gap before the status cell
  const name = clamp(row.name, Math.max(0, nameBudget));
  const left = `${icon(row.outcome, spinnerFrame)} ${color.dim(row.method.padEnd(METHOD_W))} ${name}`;
  const leftVisible = ROW_PREFIX + name.length;
  const gap = Math.max(1, inner - leftVisible - rPlain.length);
  return frameLine(
    `${left}${' '.repeat(gap)}${rColored}`,
    leftVisible + gap + rPlain.length,
    width
  );
}

/** A bordered line carrying arbitrary already-coloured content of known width. */
function frameLine(coloredContent: string, visibleLen: number, width: number): string {
  const inner = width - 4;
  const pad = ' '.repeat(Math.max(0, inner - visibleLen));
  return `${color.gray(BOX.v)} ${coloredContent}${pad} ${color.gray(BOX.v)}`;
}

function progressLine(state: TuiState, width: number): string {
  const inner = width - 4;
  const total = state.total;
  const done = state.rows.length;
  const label = total ? `${done}/${total}` : `${done}`;
  // Counts are derived from rows (which only ever holds settled requests) rather
  // than tracked as separate fields that must stay in lockstep.
  let passed = 0;
  let failTotal = 0;
  for (const r of state.rows) {
    if (r.outcome === 'pass') passed++;
    else failTotal++;
  }
  const countsPlain = `✓${passed} ✗${failTotal}`;
  const counts = `${color.green(`✓${passed}`)} ${failTotal > 0 ? color.red(`✗${failTotal}`) : color.dim(`✗${failTotal}`)}`;

  if (!total) {
    const content = `${color.bold(label)}  ${counts}`;
    return frameLine(content, label.length + 2 + countsPlain.length, width);
  }

  const ratio = Math.min(1, done / total);
  const pct = `${Math.round(ratio * 100)}%`;
  // label + space + bar + space + pct + 2 spaces + counts
  const fixed = label.length + 1 + 1 + pct.length + 2 + countsPlain.length;
  const barW = Math.max(4, inner - fixed);
  const filled = Math.round(barW * ratio);
  const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(barW - filled));
  const content = `${color.bold(label)} ${bar} ${pct}  ${counts}`;
  const visible = label.length + 1 + barW + 1 + pct.length + 2 + countsPlain.length;
  return frameLine(content, visible, width);
}

/**
 * Pure render of the dashboard for a given state — no I/O, so it can be
 * unit-tested. Every line is exactly `width` visible columns wide so the box
 * borders align. When `rows` exceeds the window, the oldest are dropped and an
 * "N earlier" indicator takes their place.
 */
export function renderFrame(state: TuiState, opts: RenderOpts): string {
  const width = Math.max(MIN_WIDTH, opts.width);
  const borderInner = width - 2; // between the two corner characters

  const title = ` ${state.collectionName} `;
  const top =
    color.gray(BOX.tl) +
    color.bold(title) +
    color.gray(BOX.h.repeat(Math.max(0, borderInner - title.length)) + BOX.tr);
  const mid = color.gray(BOX.ml + BOX.h.repeat(borderInner) + BOX.mr);
  const bottom = color.gray(BOX.bl + BOX.h.repeat(borderInner) + BOX.br);

  const lines: string[] = [top];

  const hasCurrent = Boolean(state.current) && !state.done;
  const window = Math.max(1, opts.maxRows - (hasCurrent ? 1 : 0));
  const shown = state.rows.slice(-window);
  const hidden = state.rows.length - shown.length;

  if (hidden > 0) {
    const text = `… ${hidden} earlier`;
    lines.push(frameLine(color.dim(text), text.length, width));
  }
  for (const row of shown) lines.push(rowLine(row, state.spinnerFrame, width));
  if (hasCurrent && state.current) lines.push(rowLine(state.current, state.spinnerFrame, width));

  lines.push(mid, progressLine(state, width), bottom);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Imperative reporter shell
// ---------------------------------------------------------------------------

export class TuiReporter implements Reporter {
  private state: TuiState = {
    collectionName: '',
    rows: [],
    spinnerFrame: 0,
    done: false,
  };
  private timer: ReturnType<typeof setInterval> | undefined;
  // Drive all spinner animation off interactivity; a forced `--reporter tui`
  // in a non-TTY renders a single final frame instead of spamming the log.
  private readonly animate = interactive;
  private readonly onSigint = (): void => {
    this.teardown();
    showCursor();
    process.exit(130);
  };

  onStart(meta: RunMeta): void {
    this.state.collectionName = meta.collectionName;
    if (meta.total !== undefined) this.state.total = meta.total;
    if (!this.animate) return;
    hideCursor();
    process.on('SIGINT', this.onSigint);
    this.timer = setInterval(() => {
      if (!this.state.current) return; // nothing to animate between requests
      this.state.spinnerFrame++;
      this.render();
    }, 80);
    this.render();
  }

  onRequestStart(request: LoadedRequest): void {
    this.state.current = {
      method: methodOf(request),
      name: request.request.name,
      outcome: 'running',
    };
    if (this.animate) this.render();
  }

  onRequestComplete(result: RequestRunResult): void {
    const outcome: RowOutcome = result.errorMessage ? 'error' : result.passed ? 'pass' : 'fail';
    this.state.current = undefined;
    this.state.rows.push({
      method: methodOf(result.request),
      name: result.request.request.name,
      outcome,
      status: result.status,
      durationMs: result.durationMs,
    });
    if (this.animate) this.render();
  }

  onEnd(result: RunResult): void {
    this.state.done = true;
    this.state.current = undefined;
    this.teardown();
    if (this.animate) {
      logUpdate.clear();
      showCursor();
    } else {
      // Non-interactive forced run: emit a single final frame.
      const width = Math.max(MIN_WIDTH, process.stdout.columns ?? 80);
      console.log(renderFrame(this.state, { width, maxRows: this.state.rows.length || 1 }));
    }
    this.printSummary(result);
  }

  private render(): void {
    const width = Math.max(MIN_WIDTH, process.stdout.columns ?? 80);
    const height = process.stdout.rows ?? 24;
    const maxRows = Math.max(3, height - 6); // box chrome: top + mid + progress + bottom + margin
    logUpdate(renderFrame(this.state, { width, maxRows }));
  }

  private teardown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    process.removeListener('SIGINT', this.onSigint);
  }

  /** Persist a clean final summary to scrollback: failures first, then totals. */
  private printSummary(result: RunResult): void {
    console.log('');
    for (const r of result.requests) {
      if (!r.passed) console.log(formatRequestLine(r));
    }
    console.log(formatSummaryLine(result));
  }
}
