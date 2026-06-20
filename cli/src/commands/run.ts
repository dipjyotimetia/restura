import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { runCollection, type RunOptions } from '../runner/runner.js';
import { loadEnv } from '../runner/envLoader.js';
import { loadIterationData } from '../runner/dataLoader.js';
import { parseRetryOn } from '../runner/retry.js';
import { JsonReporter } from '../reporters/json.js';
import { JUnitReporter } from '../reporters/junit.js';
import { HtmlReporter } from '../reporters/html.js';
import { LiveReporter } from '../reporters/live.js';
import { StatsReporter } from '../reporters/stats.js';
import { CompositeReporter } from '../reporters/composite.js';
import type { Reporter } from '../reporters/types.js';

interface RunOpts {
  env?: string;
  reporter: string;
  output?: string;
  reporterOutput?: string[];
  bail: boolean;
  timeout: string;
  allowLocalhost: boolean;
  folder?: string;
  include?: string[];
  exclude?: string[];
  data?: string;
  maxIterations?: string;
  retry: string;
  retryOn: string;
  sseDuration?: string;
  sseEvents?: string;
  insecure?: boolean;
  ca?: string;
  clientCert?: string;
  clientKey?: string;
  certPassphrase?: string;
}

/** Build TLS options from --insecure / --ca / --client-cert / --client-key. */
function buildTls(opts: RunOpts): RunOptions['tls'] | undefined {
  const tls: NonNullable<RunOptions['tls']> = {};
  if (opts.insecure) tls.rejectUnauthorized = false;
  if (opts.ca) tls.ca = readFileSync(opts.ca, 'utf-8');
  if (opts.clientCert) tls.cert = readFileSync(opts.clientCert, 'utf-8');
  if (opts.clientKey) tls.key = readFileSync(opts.clientKey, 'utf-8');
  if (opts.certPassphrase) tls.passphrase = opts.certPassphrase;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

/**
 * Wires the `restura run <collection>` subcommand into the root program.
 *
 * `<collection>` accepts either a directory (OpenCollection or legacy layout)
 * or a single bundled OpenCollection `.yaml`/`.yml` file.
 *
 * Exit codes:
 *   0 — every request passed AND at least one request was run
 *   1 — one or more requests failed or errored (or the collection was empty)
 *   2 — internal error (missing collection, bad reporter name, IO failure, …)
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a Restura collection')
    .argument(
      '<collection>',
      'Path to a collection directory (OpenCollection or legacy `_collection.yaml`) or a bundled YAML file'
    )
    .option('--env <file>', 'Path to env file (json or yaml)')
    .option(
      '--reporter <list>',
      'Reporter(s) to use, comma-separated: live | json | junit | html | stats',
      'live'
    )
    .option('--output <file>', 'Output path when only one file reporter is used')
    .option(
      '--reporter-output <kv...>',
      'Per-reporter output paths: --reporter-output junit=junit.xml html=report.html'
    )
    .option('--bail', 'Stop on first failure', false)
    .option('--timeout <ms>', 'Per-request timeout', '30000')
    .option('--allow-localhost', 'Permit localhost / 127.0.0.1 targets (off by default)', false)
    .option('--folder <path>', 'Only run requests under this folder path')
    .option('--include <pattern...>', 'Include requests matching pattern (repeatable)')
    .option('--exclude <pattern...>', 'Exclude requests matching pattern (repeatable)')
    .option('--data <file>', 'CSV or JSON file driving iterations (one row per iteration)')
    .option(
      '--max-iterations <n>',
      'Cap the number of iterations (safety against large data files)'
    )
    .option('--retry <n>', 'Number of retry attempts on failure', '0')
    .option(
      '--retry-on <list>',
      'Comma-separated retry triggers: network,5xx,4xx,<status>',
      'network,5xx'
    )
    .option('--sse-duration <ms>', 'How long to keep SSE streams open', '5000')
    .option('--sse-events <n>', 'Stop SSE after N events received')
    .option('--insecure', 'Skip TLS certificate verification (self-signed / staging)')
    .option('--ca <file>', 'PEM CA bundle to trust (private CA)')
    .option('--client-cert <file>', 'PEM client certificate for mutual TLS')
    .option('--client-key <file>', 'PEM client private key for mutual TLS')
    .option('--cert-passphrase <value>', 'Passphrase for an encrypted client key')
    .action(async (collectionPath: string, opts: RunOpts) => {
      try {
        const envVars = opts.env ? await loadEnv(opts.env, { expandEnvVars: true }) : {};
        const iterations = await loadIterationData(opts.data);
        const reporter = buildReporters(opts);
        const tls = buildTls(opts);

        const result = await runCollection(
          collectionPath,
          {
            envVars,
            bail: Boolean(opts.bail),
            timeoutMs: numericFlag('--timeout', opts.timeout, { min: 1 }),
            allowLocalhost: Boolean(opts.allowLocalhost),
            filter: {
              ...(opts.folder ? { folder: opts.folder } : {}),
              ...(opts.include ? { include: opts.include } : {}),
              ...(opts.exclude ? { exclude: opts.exclude } : {}),
            },
            iterations,
            ...(opts.maxIterations !== undefined
              ? { maxIterations: numericFlag('--max-iterations', opts.maxIterations, { min: 1 }) }
              : {}),
            retry: {
              retries: numericFlag('--retry', opts.retry, { min: 0 }),
              retryOn: parseRetryOn(opts.retryOn),
            },
            ...(opts.sseDuration !== undefined
              ? { sseDurationMs: numericFlag('--sse-duration', opts.sseDuration, { min: 0 }) }
              : {}),
            ...(opts.sseEvents !== undefined
              ? { sseMaxEvents: numericFlag('--sse-events', opts.sseEvents, { min: 1 }) }
              : {}),
            ...(tls ? { tls } : {}),
          },
          reporter
        );

        const ok =
          result.summary.passed === result.summary.total &&
          result.summary.errored === 0 &&
          result.summary.total > 0;
        process.exit(ok ? 0 : 1);
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
    });
}

/**
 * Build the reporter chain. `--reporter live,junit` makes a CompositeReporter
 * wrapping both. File reporters resolve their output path in this order:
 *   1. `--reporter-output <name>=<path>` (preferred for multi-reporter)
 *   2. `--output <path>` (legacy single-reporter shorthand)
 */
function buildReporters(opts: RunOpts): Reporter {
  const names = opts.reporter
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('At least one reporter must be specified');

  const outputs = parseReporterOutputs(opts.reporterOutput);
  const reporters = names.map((name) => buildOne(name, outputs[name] ?? opts.output));
  return reporters.length === 1 ? reporters[0]! : new CompositeReporter(reporters);
}

/**
 * Parse a numeric CLI flag, throwing a clear error (→ exit 2) on a non-finite
 * or out-of-range value instead of silently coercing to NaN. NaN would
 * otherwise disable a cap (`NaN >= 0` is false) or a timeout with no warning.
 */
function numericFlag(name: string, value: string, opts: { min: number }): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} expects a number, got: ${value}`);
  }
  if (n < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}, got: ${value}`);
  }
  return n;
}

function parseReporterOutputs(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`--reporter-output expects key=value, got: ${pair}`);
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (!key || !val) throw new Error(`--reporter-output expects key=value, got: ${pair}`);
    out[key] = val;
  }
  return out;
}

function buildOne(name: string, outputPath: string | undefined): Reporter {
  switch (name) {
    case 'live':
      return new LiveReporter();
    case 'json':
      if (!outputPath)
        throw new Error('--reporter json requires --output or --reporter-output json=<path>');
      return new JsonReporter(outputPath);
    case 'junit':
      if (!outputPath)
        throw new Error('--reporter junit requires --output or --reporter-output junit=<path>');
      return new JUnitReporter(outputPath);
    case 'html':
      if (!outputPath)
        throw new Error('--reporter html requires --output or --reporter-output html=<path>');
      return new HtmlReporter(outputPath);
    case 'stats':
      return new StatsReporter();
    default:
      throw new Error(`Unknown reporter '${name}'. Use one of: live | json | junit | html | stats`);
  }
}
