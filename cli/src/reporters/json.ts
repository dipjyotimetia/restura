import { writeFile } from 'node:fs/promises';
import { redactRunResult } from './redact.js';
import type { Reporter, RunResult } from './types.js';

/**
 * Writes the RunResult as pretty-printed JSON to a file. Useful for
 * downstream tooling, archival, or piping into custom reporting. Requests are
 * reported as a redacted projection (`redact.ts`): no auth secrets, headers or
 * bodies reach the artifact.
 */
export class JsonReporter implements Reporter {
  private readonly outputPath: string;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  async onEnd(result: RunResult): Promise<void> {
    await writeFile(this.outputPath, JSON.stringify(redactRunResult(result), null, 2), 'utf-8');
  }
}
