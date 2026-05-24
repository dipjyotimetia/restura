import type { Reporter, RunMeta, RunResult, RequestRunResult } from './types.js';
import type { LoadedRequest } from '../runner/collectionLoader.js';

/**
 * Fan-out reporter. Forwards each lifecycle event to every wrapped reporter
 * in declaration order, awaiting each so file-writing reporters complete
 * before the process exits.
 */
export class CompositeReporter implements Reporter {
  constructor(private readonly children: Reporter[]) {}

  async onStart(meta: RunMeta): Promise<void> {
    for (const c of this.children) await c.onStart?.(meta);
  }

  async onRequestStart(request: LoadedRequest): Promise<void> {
    for (const c of this.children) await c.onRequestStart?.(request);
  }

  async onRequestComplete(result: RequestRunResult): Promise<void> {
    for (const c of this.children) await c.onRequestComplete?.(result);
  }

  async onEnd(result: RunResult): Promise<void> {
    for (const c of this.children) await c.onEnd(result);
  }
}
