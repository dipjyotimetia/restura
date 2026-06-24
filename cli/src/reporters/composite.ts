import type { LoadedRequest } from '../runner/collectionLoader.js';
import type { Reporter, RunMeta, RunResult, RequestRunResult } from './types.js';

/**
 * Fan-out reporter. Forwards each lifecycle event to every wrapped reporter
 * in declaration order. A failure in one reporter must not suppress the others
 * (e.g. an HTML write error must not stop the CI-gating JUnit file from being
 * written), so each call is isolated:
 *   - mid-run events (start / per-request) log the error and continue;
 *   - `onEnd` runs every child, then rethrows an aggregate so a failed report
 *     write still surfaces as a non-zero exit — after all outputs are flushed.
 */
export class CompositeReporter implements Reporter {
  constructor(private readonly children: Reporter[]) {}

  async onStart(meta: RunMeta): Promise<void> {
    for (const c of this.children) await this.safe(() => c.onStart?.(meta));
  }

  async onRequestStart(request: LoadedRequest): Promise<void> {
    for (const c of this.children) await this.safe(() => c.onRequestStart?.(request));
  }

  async onRequestComplete(result: RequestRunResult): Promise<void> {
    for (const c of this.children) await this.safe(() => c.onRequestComplete?.(result));
  }

  async onEnd(result: RunResult): Promise<void> {
    const errors: unknown[] = [];
    for (const c of this.children) {
      try {
        await c.onEnd(result);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
      throw new Error(`reporter(s) failed: ${messages.join('; ')}`);
    }
  }

  private async safe(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      process.stderr.write(
        `[restura] reporter error: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}
