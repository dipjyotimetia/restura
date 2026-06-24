import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CompositeReporter } from '../reporters/composite.js';
import { HtmlReporter } from '../reporters/html.js';
import { JsonReporter } from '../reporters/json.js';
import { JUnitReporter } from '../reporters/junit.js';
import { LiveReporter } from '../reporters/live.js';
import { StatsReporter } from '../reporters/stats.js';
import { TuiReporter } from '../reporters/tui.js';
import type { Reporter } from '../reporters/types.js';
import { loadIterationData } from '../runner/dataLoader.js';
import { loadEnv } from '../runner/envLoader.js';
import { parseRetryOn } from '../runner/retry.js';
import { runCollection, type RunOptions } from '../runner/runner.js';
import { interactive, showCursor } from '../ui/colors.js';
import { runWizard } from '../ui/wizard.js';

export interface RunOpts {
  env?: string;
  reporter?: string;
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
  proxy?: string;
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
 * Wires the `restura run [collection]` subcommand into the root program.
 *
 * `[collection]` accepts either a directory (OpenCollection or legacy layout)
 * or a single bundled OpenCollection `.yaml`/`.yml` file. When omitted in an
 * interactive terminal the wizard prompts for it; in a non-TTY (CI) a missing
 * collection is exit 2 — the wizard never blocks on stdin.
 *
 * Exit codes:
 *   0 — every request passed AND at least one request was run
 *   1 — one or more requests failed or errored (or the collection was empty)
 *   2 — internal error (missing collection in CI, bad reporter name, IO failure, …)
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description(
      'Run a Restura collection (omit <collection> in a terminal for an interactive wizard)'
    )
    .argument(
      '[collection]',
      'Path to a collection directory (OpenCollection or legacy `_collection.yaml`) or a bundled YAML file. Omit in a TTY to pick one interactively.'
    )
    .option('--env <file>', 'Path to env file (json or yaml)')
    .option(
      '--reporter <list>',
      'Reporter(s), comma-separated: tui | live | json | junit | html | stats (default: tui in a terminal, live otherwise)'
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
    .option('--proxy <url>', 'HTTP(S) proxy URL (overrides HTTP_PROXY; composes with TLS options)')
    .action(async (collectionPath: string | undefined, opts: RunOpts) => {
      // A missing collection launches the wizard in a TTY; in CI it's an error
      // (never block on stdin) matching commander's required-argument behaviour.
      if (!collectionPath) {
        if (!interactive) {
          console.error(
            "✗ missing required argument 'collection'. Pass a path (e.g. `restura run ./my-collection`) " +
              'or run in an interactive terminal to pick one.'
          );
          process.exit(2);
        }
        const wiz = await runWizard();
        await executeRun(wiz.collectionPath, { ...opts, ...wiz.opts });
        return;
      }
      await executeRun(collectionPath, opts);
    });
}

/**
 * Execute a fully-resolved run: load env + iteration data, build the reporter
 * chain, run the collection, and exit with the documented code. Extracted from
 * the command action so the interactive wizard and a direct `run <collection>`
 * invocation share one code path. Always exits the process.
 */
export async function executeRun(collectionPath: string, opts: RunOpts): Promise<never> {
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
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
      },
      reporter
    );

    const ok =
      result.summary.passed === result.summary.total &&
      result.summary.errored === 0 &&
      result.summary.total > 0;
    process.exit(ok ? 0 : 1);
  } catch (err) {
    showCursor(); // the live dashboard hides the cursor — restore it before bailing
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

/**
 * Build the reporter chain. `--reporter live,junit` makes a CompositeReporter
 * wrapping both. File reporters resolve their output path in this order:
 *   1. `--reporter-output <name>=<path>` (preferred for multi-reporter)
 *   2. `--output <path>` (legacy single-reporter shorthand)
 */
function buildReporters(opts: RunOpts): Reporter {
  // Default reporter is TTY-aware: the live dashboard in an interactive
  // terminal, plain lines otherwise (piped output / CI logs).
  const spec = opts.reporter ?? (interactive ? 'tui' : 'live');
  const names = spec
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
    case 'tui':
      return new TuiReporter();
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
      throw new Error(
        `Unknown reporter '${name}'. Use one of: tui | live | json | junit | html | stats`
      );
  }
}
