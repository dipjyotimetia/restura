import { Command } from 'commander';
import { runCollection } from '../runner/runner.js';
import { loadEnv } from '../runner/envLoader.js';
import { JsonReporter } from '../reporters/json.js';
import { JUnitReporter } from '../reporters/junit.js';
import { HtmlReporter } from '../reporters/html.js';
import { LiveReporter } from '../reporters/live.js';
import type { Reporter } from '../reporters/types.js';

/**
 * Wires the `restura run <collection-dir>` subcommand into the root program.
 *
 * Exit codes:
 *   0 — every request passed (status 2xx) AND at least one request was run
 *   1 — one or more requests failed or errored (or the collection was empty)
 *   2 — internal error (missing collection, bad reporter name, IO failure, …)
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a Restura collection')
    .argument(
      '<collection-dir>',
      'Path to a collection directory (containing _collection.yaml)'
    )
    .option('--env <file>', 'Path to env file (json or yaml)')
    .option('--reporter <name>', 'Reporter: live | json | junit | html', 'live')
    .option('--output <file>', 'Output path for json/junit/html reporters')
    .option('--bail', 'Stop on first failure', false)
    .option('--timeout <ms>', 'Per-request timeout', '30000')
    .option(
      '--allow-localhost',
      'Permit localhost / 127.0.0.1 targets (off by default)',
      false
    )
    .action(
      async (
        collectionDir: string,
        opts: {
          env?: string;
          reporter: string;
          output?: string;
          bail: boolean;
          timeout: string;
          allowLocalhost: boolean;
        }
      ) => {
        try {
          const envVars = opts.env ? await loadEnv(opts.env, { expandEnvVars: true }) : {};
          const reporter = pickReporter(opts.reporter, opts.output);
          const result = await runCollection(
            collectionDir,
            {
              envVars,
              bail: Boolean(opts.bail),
              timeoutMs: Number(opts.timeout),
              allowLocalhost: Boolean(opts.allowLocalhost),
            },
            reporter
          );
          process.exit(
            result.summary.passed === result.summary.total && result.summary.total > 0
              ? 0
              : 1
          );
        } catch (err) {
          console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
          process.exit(2);
        }
      }
    );
}

function pickReporter(name: string, outputPath?: string): Reporter {
  switch (name) {
    case 'live':
      return new LiveReporter();
    case 'json':
      if (!outputPath) throw new Error('--reporter json requires --output');
      return new JsonReporter(outputPath);
    case 'junit':
      if (!outputPath) throw new Error('--reporter junit requires --output');
      return new JUnitReporter(outputPath);
    case 'html':
      if (!outputPath) throw new Error('--reporter html requires --output');
      return new HtmlReporter(outputPath);
    default:
      throw new Error(`Unknown reporter '${name}'. Use one of: live | json | junit | html`);
  }
}
