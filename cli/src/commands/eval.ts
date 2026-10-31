import { readFile, writeFile } from 'node:fs/promises';
import { knownCostUSD } from '@shared/agent-lab';
import { type EvalModelPort, runEvalCore } from '@shared/ai-lab/evalCore';
import { type EvalEndpoint, type EvalFile, EvalFileSchema } from '@shared/ai-lab/evalFile';
import { evalPassOutcome } from '@shared/ai-lab/evalPassThreshold';
import { selfJudgingScorer } from '@shared/ai-lab/judgePolicy';
import type { EvalCellResult, ModelRef } from '@shared/ai-lab/types';
import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import { getProviderModule } from '@shared/protocol/ai/providers';
import { hasStaticPricing, isLocalProvider, type Usage } from '@shared/protocol/ai/types';
import type { Fetcher } from '@shared/protocol/types';
import { validateURL } from '@shared/protocol/url-validation';
import { runScriptScorer } from '@shared/scripts/eval-script-scorer';
import type { Command } from 'commander';
import { escapeXml } from '../reporters/junit.js';
import { undiciFetcher } from '../runner/undiciFetcher.js';

export interface EvalRunOptions {
  output?: string;
  junit?: string;
  /** USD ceiling across every model and judge call. */
  maxCost?: string;
  /** Run only the train or test split. */
  split?: string;
  concurrency?: string;
  allowLocalhost?: boolean;
  signal?: AbortSignal;
}

export interface EvalRunDependencies {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  fetcher: Fetcher;
  environment: Readonly<Record<string, string | undefined>>;
}

const defaultDependencies: EvalRunDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  writeText: (path, content) => writeFile(path, content, 'utf8'),
  fetcher: undiciFetcher,
  environment: process.env,
};

export type EvalRunStatus = 'passed' | 'failed' | 'cancelled';

export interface EvalRunReport {
  kind: 'restura.eval.report';
  schemaVersion: 1;
  name: string;
  status: EvalRunStatus;
  reason?: string;
  passThreshold: number;
  passed: number;
  scored: number;
  passRate: number;
  totalCells: number;
  /** Known spend across model and judge calls (USD). */
  costUSD: number;
  /** Calls whose cost could not be priced. */
  unpricedCalls: number;
  startedAt: string;
  finishedAt: string;
  cells: EvalCellResult[];
}

/** Invalid input: refused before any model call (exit 2). */
export class EvalPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalPreflightError';
  }
}

class BudgetExceededError extends Error {
  constructor(spent: number, max: number) {
    super(`cost budget exceeded: $${spent.toFixed(4)} spent, budget $${max}`);
    this.name = 'BudgetExceededError';
  }
}

function numberFlag(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new EvalPreflightError(`${name} must be a non-negative number`);
  }
  return value;
}

function modelPriceFor(file: EvalFile, endpoint: EvalEndpoint, model: string) {
  const override =
    file.modelPrices && Object.hasOwn(file.modelPrices, model)
      ? file.modelPrices[model]
      : undefined;
  if (override) return override;
  if (!hasStaticPricing(endpoint.provider)) return undefined;
  return getProviderModule(endpoint.provider).models.find((candidate) => candidate.id === model);
}

/** Every model the run calls: those under test and every judge. */
function calledModels(file: EvalFile): ModelRef[] {
  return [
    ...file.models,
    ...file.scorers.flatMap((scorer) =>
      scorer.kind === 'judge' || scorer.kind === 'pairwise' ? [scorer.judgeModel] : []
    ),
  ];
}

/**
 * Refuse anything that would only fail at run time, before a single model
 * call: unknown or keyless endpoints, unsafe base URLs, self-judging, budgets
 * over unpriced models, and the desktop-only http-exec target.
 */
export function preflightEvalFile(
  file: EvalFile,
  options: {
    environment: EvalRunDependencies['environment'];
    maxCost?: number;
    allowLocalhost: boolean;
  }
): Map<string, { endpoint: EvalEndpoint; apiKey: string }> {
  if (file.scorers.length === 0) {
    throw new EvalPreflightError('the eval has no scorers, so nothing would be evaluated');
  }
  if (file.target?.kind === 'http-exec') {
    throw new EvalPreflightError(
      'the http-exec target runs on desktop only (it executes requests through the app request executor)'
    );
  }
  const selfJudging = selfJudgingScorer(file.scorers, file.models);
  if (selfJudging) {
    throw new EvalPreflightError(
      `scorer ${selfJudging.id} judges with a model under test (${selfJudging.judgeModel.model}); pick a different judge`
    );
  }

  const resolved = new Map<string, { endpoint: EvalEndpoint; apiKey: string }>();
  // Only endpoints the run calls need credentials; unused ones are ignored.
  const referenced = new Set(calledModels(file).map((model) => model.providerConfigId));
  for (const id of referenced) {
    const endpoint = file.endpoints[id]!;
    const local = isLocalProvider(endpoint.provider);
    if (
      (endpoint.provider === 'azure-openai' || endpoint.provider === 'openai-compatible') &&
      !endpoint.baseUrl
    ) {
      throw new EvalPreflightError(`endpoint ${id} (${endpoint.provider}) needs a baseUrl`);
    }
    const url = resolveBaseUrl(endpoint.provider, endpoint.baseUrl);
    if (!local && !url.startsWith('https://')) {
      throw new EvalPreflightError(`endpoint ${id} must use https`);
    }
    const checked = validateURL(url, {
      allowLocalhost: local && options.allowLocalhost,
      allowPrivateIPs: local && options.allowLocalhost,
    });
    if (!checked.valid) {
      throw new EvalPreflightError(
        `endpoint ${id} base URL rejected: ${checked.error}${local ? ' (pass --allow-localhost for a local runtime)' : ''}`
      );
    }
    let apiKey = '';
    if (endpoint.credentialEnv) {
      apiKey = options.environment[endpoint.credentialEnv] ?? '';
      if (!apiKey) {
        throw new EvalPreflightError(
          `endpoint ${id} needs environment variable ${endpoint.credentialEnv}`
        );
      }
    } else if (!local) {
      throw new EvalPreflightError(`endpoint ${id} (${endpoint.provider}) needs credentialEnv`);
    }
    resolved.set(id, { endpoint, apiKey });
  }

  if (options.maxCost !== undefined) {
    for (const model of calledModels(file)) {
      const endpoint = file.endpoints[model.providerConfigId]!;
      if (endpoint.provider !== 'ollama' && !modelPriceFor(file, endpoint, model.model)) {
        throw new EvalPreflightError(
          `--max-cost needs a known price, but ${endpoint.provider} model ${model.model} is unpriced; add it under modelPrices`
        );
      }
    }
  }
  return resolved;
}

const CREDENTIAL_HANDLE = 'eval-credential';

function cliEvalPort(
  file: EvalFile,
  endpoints: Map<string, { endpoint: EvalEndpoint; apiKey: string }>,
  fetcher: Fetcher,
  spend: { costUSD: number; unpricedCalls: number; maxCost?: number; abort(reason: unknown): void }
): EvalModelPort {
  const costOf = (model: ModelRef, usage: Usage | undefined): number | null => {
    const resolved = endpoints.get(model.providerConfigId);
    if (!resolved) return null;
    if (resolved.endpoint.provider === 'ollama') return 0;
    if (!usage) return null;
    const override = file.modelPrices?.[model.model];
    if (override) {
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      return (
        knownCostUSD(override, {
          input: usage.promptTokens - cacheRead - cacheWrite,
          cacheRead,
          cacheWrite,
          output: usage.completionTokens,
        }) ?? null
      );
    }
    return hasStaticPricing(resolved.endpoint.provider) ? usage.estimatedCostUSD : null;
  };
  return {
    has: (model) => endpoints.has(model.providerConfigId),
    async complete(model, messages, { tools, signal }) {
      if (spend.maxCost !== undefined && spend.costUSD >= spend.maxCost) {
        const error = new BudgetExceededError(spend.costUSD, spend.maxCost);
        spend.abort(error);
        throw error;
      }
      const { endpoint, apiKey } = endpoints.get(model.providerConfigId)!;
      const result = await runToCompletion(
        {
          provider: endpoint.provider,
          model: model.model,
          messages,
          apiKeyHandleId: apiKey ? CREDENTIAL_HANDLE : '',
          // Same rule as desktop: the outgoing secret check is on for cloud
          // providers and off for local runtimes.
          rawMode: isLocalProvider(endpoint.provider),
          ...(endpoint.baseUrl ? { baseUrlOverride: endpoint.baseUrl } : {}),
          ...(tools ? { tools } : {}),
          signal,
        },
        fetcher,
        async (handle) => (handle === CREDENTIAL_HANDLE ? apiKey : undefined)
      );
      if (result.ok) {
        const cost = costOf(model, result.usage);
        if (cost === null) spend.unpricedCalls += 1;
        else spend.costUSD += cost;
      }
      return result;
    },
    cost: costOf,
  };
}

/** Parse, preflight and run an eval file; writes the requested reports. */
export async function evaluateEvalFile(
  path: string,
  options: EvalRunOptions = {},
  dependencies: EvalRunDependencies = defaultDependencies
): Promise<EvalRunReport> {
  let file: EvalFile;
  try {
    file = EvalFileSchema.parse(JSON.parse(await dependencies.readText(path)));
  } catch (error) {
    throw new EvalPreflightError(
      `invalid eval file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const maxCost = numberFlag('--max-cost', options.maxCost);
  const concurrency = numberFlag('--concurrency', options.concurrency);
  if (options.split !== undefined && options.split !== 'train' && options.split !== 'test') {
    throw new EvalPreflightError('--split must be train or test');
  }
  const cases = options.split
    ? file.dataset.cases.filter((c) => (c.split ?? 'train') === options.split)
    : file.dataset.cases;
  if (cases.length === 0) throw new EvalPreflightError('no dataset cases match the selected split');
  const endpoints = preflightEvalFile(file, {
    environment: dependencies.environment,
    ...(maxCost !== undefined ? { maxCost } : {}),
    allowLocalhost: Boolean(options.allowLocalhost),
  });

  const controller = new AbortController();
  const forward = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) forward();
  const spend = {
    costUSD: 0,
    unpricedCalls: 0,
    ...(maxCost !== undefined ? { maxCost } : {}),
    abort: (reason: unknown) => controller.abort(reason),
  };

  const startedAt = new Date();
  let cells: EvalCellResult[] = [];
  let interruption: string | undefined;
  try {
    cells = await runEvalCore(
      {
        prompt: file.prompt,
        dataset: { cases },
        models: file.models,
        scorers: file.scorers,
        concurrency: Math.max(1, Math.min(32, Math.floor(concurrency ?? file.concurrency))),
        port: cliEvalPort(file, endpoints, dependencies.fetcher, spend),
        runScript: runScriptScorer,
        ...(file.tools ? { tools: file.tools } : {}),
      },
      (progress) => {
        cells = [...progress.cells];
      },
      controller.signal
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const reason = controller.signal.reason;
    interruption = reason instanceof Error ? reason.message : 'interrupted';
  } finally {
    options.signal?.removeEventListener('abort', forward);
  }
  if (!interruption && controller.signal.aborted) {
    const reason = controller.signal.reason;
    interruption = reason instanceof Error ? reason.message : 'interrupted';
  }

  const outcome = evalPassOutcome(cells, file.passThreshold);
  const status: EvalRunStatus = interruption
    ? 'cancelled'
    : outcome.status === 'passed'
      ? 'passed'
      : 'failed';
  const reason = interruption ?? outcome.reason;
  const report: EvalRunReport = {
    kind: 'restura.eval.report',
    schemaVersion: 1,
    name: file.name,
    status,
    ...(reason ? { reason } : {}),
    passThreshold: file.passThreshold,
    passed: outcome.passed,
    scored: outcome.scored,
    passRate: outcome.scored ? outcome.passed / outcome.scored : 0,
    totalCells: cases.length * file.models.length,
    costUSD: spend.costUSD,
    unpricedCalls: spend.unpricedCalls,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cells,
  };
  if (options.output) {
    await dependencies.writeText(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.junit) {
    await dependencies.writeText(options.junit, renderEvalJUnit(report, file));
  }
  return report;
}

/** One `<testcase>` per case × model cell; scorer failures are `<failure>`, call errors `<error>`. */
export function renderEvalJUnit(report: EvalRunReport, file: EvalFile): string {
  const label = (model: ModelRef) => {
    const endpoint = file.endpoints[model.providerConfigId];
    return `${endpoint?.label ?? model.providerConfigId}/${model.model}`;
  };
  const cases = report.cells.map((cell) => {
    const attrs = `classname="${escapeXml(label(cell.modelRef))}" name="${escapeXml(cell.caseId)}" time="${(cell.latencyMs / 1000).toFixed(3)}"`;
    if (cell.error) {
      return `    <testcase ${attrs}><error message="${escapeXml(cell.error)}">${escapeXml(cell.error)}</error></testcase>`;
    }
    if (cell.notEvaluated) return `    <testcase ${attrs}><skipped/></testcase>`;
    if (!cell.passed) {
      const failed = cell.scores.filter((score) => !score.passed);
      const detail = failed
        .map(
          (score) => `${score.scorerId} (${score.kind})${score.detail ? `: ${score.detail}` : ''}`
        )
        .join('\n');
      return `    <testcase ${attrs}><failure message="${escapeXml(`${failed.length} scorer(s) failed`)}">${escapeXml(detail)}</failure></testcase>`;
    }
    return `    <testcase ${attrs}/>`;
  });
  const failures = report.cells.filter(
    (cell) => !cell.error && !cell.notEvaluated && !cell.passed
  ).length;
  const errors = report.cells.filter((cell) => cell.error).length;
  const skipped = report.cells.filter((cell) => cell.notEvaluated).length;
  const time = report.cells.reduce((total, cell) => total + cell.latencyMs, 0) / 1000;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="restura eval" tests="${report.cells.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    `  <testsuite name="${escapeXml(report.name)}" tests="${report.cells.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    `    <properties><property name="status" value="${report.status}"/><property name="passRate" value="${report.passRate.toFixed(4)}"/><property name="passThreshold" value="${report.passThreshold}"/></properties>`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export function evalRunExitCode(value: EvalRunReport | Error): 0 | 1 | 2 {
  if (value instanceof EvalPreflightError) return 2;
  if (value instanceof Error) return 2;
  return value.status === 'passed' ? 0 : 1;
}

/** Run one eval file and return the exit code (0 pass, 1 below threshold/cancelled, 2 invalid input). */
export async function runEvalCommand(
  path: string,
  options: EvalRunOptions = {},
  dependencies: EvalRunDependencies = defaultDependencies
): Promise<0 | 1 | 2> {
  // Ctrl-C / SIGTERM stop dispatching cells; the partial report is still written.
  const interrupt = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void =>
    interrupt.abort(new Error(`${signal} received`));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const report = await evaluateEvalFile(
      path,
      { ...options, signal: interrupt.signal },
      dependencies
    );
    const { cells: _cells, ...summary } = report;
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return evalRunExitCode(report);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return evalRunExitCode(error instanceof Error ? error : new Error(String(error)));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export function registerEvalCommand(program: Command): void {
  program
    .command('eval')
    .description('Run AI Lab dataset evals in CI')
    .command('run')
    .argument('<eval>', 'Path to a restura.eval v1 JSON file (AI Lab → Evals → Export for CLI)')
    .option('--output <file>', 'Write the full JSON report (every cell and score) to a file')
    .option('--junit <file>', 'Write a JUnit XML report (one test case per case × model)')
    .option('--max-cost <usd>', 'Stop once model + judge spend reaches this many USD (exit 1)')
    .option('--split <split>', 'Run only the train or test cases')
    .option('--concurrency <n>', 'Override the eval file concurrency (1-32)')
    .option(
      '--allow-localhost',
      'Permit local runtime endpoints (Ollama, OpenAI-compatible)',
      false
    )
    .action(async (evalPath: string, options: EvalRunOptions) => {
      process.exitCode = await runEvalCommand(evalPath, options);
    });
}
