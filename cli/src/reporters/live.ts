import type { Reporter, RunResult, RequestRunResult, RunMeta } from './types.js';
import { formatRequestLine, formatSummaryLine } from './format.js';

/**
 * Line-based reporter for non-interactive runs (piped output, CI logs). Prints
 * one line per request to stdout, colourised when the terminal supports it. The
 * default `restura run` uses the live dashboard (`tui`) in an interactive
 * terminal and falls back to this; pass `--reporter live` to force it.
 */
export class LiveReporter implements Reporter {
  onStart(meta: RunMeta): void {
    console.log(`▶ Running ${meta.collectionName}`);
  }

  onRequestComplete(result: RequestRunResult): void {
    console.log(formatRequestLine(result));
  }

  onEnd(result: RunResult): void {
    console.log('');
    console.log(formatSummaryLine(result));
  }
}
