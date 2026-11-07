import { redactDiagnosticText } from '@shared/collection-run/evidence';
import { stripControl } from '@shared/protocol/mcp-conformance-text';
import { formatRequestLine, formatSummaryLine } from './format.js';
import type { Reporter, RequestRunResult, RunMeta, RunResult } from './types.js';

/**
 * Line-based reporter for non-interactive runs (piped output, CI logs). Prints
 * one line per request to stdout, colourised when the terminal supports it. The
 * default `restura run` uses the live dashboard (`tui`) in an interactive
 * terminal and falls back to this; pass `--reporter live` to force it.
 */
export class LiveReporter implements Reporter {
  onStart(meta: RunMeta): void {
    console.log(`▶ Running ${stripControl(meta.collectionName)}`);
  }

  onRequestComplete(result: RequestRunResult): void {
    console.log(formatRequestLine(result));
    // Script `console.*` output goes to stderr (stdout stays the result list),
    // token-scrubbed like the file reports (CI logs are artifacts too) and
    // stripped of control characters so a script cannot drive the terminal.
    for (const line of result.consoleLogs ?? []) {
      for (const text of line.message.split(/\r?\n/)) {
        process.stderr.write(
          `    [${line.phase} ${line.type}] ${stripControl(redactDiagnosticText(text))}\n`
        );
      }
    }
  }

  onEnd(result: RunResult): void {
    console.log('');
    console.log(formatSummaryLine(result));
  }
}
