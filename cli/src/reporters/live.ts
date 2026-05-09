import type { Reporter, RunResult, RequestRunResult, RunMeta } from './types.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/**
 * Default reporter for interactive runs. Prints per-request progress to stdout
 * with ANSI colors. Designed to be the lowest-friction path for `restura run`
 * — no `--output` flag required.
 */
export class LiveReporter implements Reporter {
  onStart(meta: RunMeta): void {
    console.log(`▶ Running ${meta.collectionName}`);
  }

  onRequestComplete(result: RequestRunResult): void {
    const icon = result.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const status = result.errorMessage
      ? `${YELLOW}ERR${RESET}`
      : `${result.passed ? GREEN : RED}${result.status}${RESET}`;
    const method =
      (result.request.request as { method?: string }).method ?? result.request.type.toUpperCase();
    console.log(
      `  ${icon} ${method} ${result.request.request.name} — ${status} ${DIM}(${result.durationMs}ms)${RESET}`
    );
    if (result.errorMessage) {
      console.log(`    ${YELLOW}${result.errorMessage}${RESET}`);
    }
  }

  onEnd(result: RunResult): void {
    const { passed, failed, errored, total } = result.summary;
    const passColor = passed === total ? GREEN : RED;
    console.log('');
    console.log(
      `${passColor}${passed}/${total} passed${RESET} (${failed} failed, ${errored} errored) in ${(result.durationMs / 1000).toFixed(2)}s`
    );
  }
}
