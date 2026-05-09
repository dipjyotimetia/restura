import { writeFile } from 'node:fs/promises';
import type { Reporter, RunResult } from './types.js';

/**
 * Writes the full RunResult as pretty-printed JSON to a file. Useful for
 * downstream tooling, archival, or piping into custom reporting.
 */
export class JsonReporter implements Reporter {
  constructor(private outputPath: string) {}

  async onEnd(result: RunResult): Promise<void> {
    await writeFile(this.outputPath, JSON.stringify(result, null, 2), 'utf-8');
  }
}
