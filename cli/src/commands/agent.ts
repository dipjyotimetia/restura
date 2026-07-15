import { readFile, writeFile } from 'node:fs/promises';
import {
  AgentRunner,
  applyAgentBundleBaseline,
  createAgentToolResolver,
  createFixtureToolSourceAdapter,
  type AgentBundle,
  AgentBundleSchema,
  type AgentSuite,
  type AgentSuiteReport,
  AgentSuiteRunner,
  type AgentToolResolver,
  AgentSuiteSchema,
  evaluateAgentBundleBaseline,
  OpenAiResponsesAdapter,
  ProviderRegistry,
} from '@shared/agent-lab';
import type { Fetcher } from '@shared/protocol/types';
import type { Command } from 'commander';
import { undiciFetcher } from '../runner/undiciFetcher.js';

export interface AgentEvalOptions {
  output?: string;
}

export interface AgentEvalDependencies {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  fetcher: Fetcher;
  environment: Readonly<Record<string, string | undefined>>;
}

const defaultDependencies: AgentEvalDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  writeText: async (path, content) => {
    await writeFile(path, content, 'utf8');
  },
  fetcher: undiciFetcher,
  environment: process.env,
};

export function preflightAgentSuite(
  suite: AgentSuite,
  toolResolver: AgentToolResolver = createAgentToolResolver()
): void {
  for (const agent of suite.agents) {
    if (agent.model.providerId !== 'openai.responses') {
      throw new Error(`headless provider adapter not registered: ${agent.model.providerId}`);
    }
    if (agent.model.baseUrl) {
      throw new Error(
        'headless agent eval refuses suite baseUrl overrides; configure a trusted adapter plugin'
      );
    }
  }

  const modelCredentials = [
    ...suite.agents.map((agent) => agent.model.credential),
    ...suite.graders.flatMap((grader) =>
      grader.kind === 'judge' ? grader.judgeModels.map((model) => model.credential) : []
    ),
  ];
  if (modelCredentials.some((credential) => credential?.source === 'secret-handle')) {
    throw new Error('secret-handle credentials require the desktop keychain');
  }

  for (const agent of suite.agents) toolResolver.assertSupported(agent.tools);
  if (suite.graders.some((grader) => grader.kind === 'judge')) {
    throw new Error('headless judge graders require a registered CLI judge adapter');
  }
}

export function agentEvalExitCode(value: AgentSuiteReport | Error): 0 | 1 | 2 {
  if (value instanceof Error) return 2;
  return value.status === 'passed' ? 0 : 1;
}

export interface AgentBundleEvaluation {
  report: AgentSuiteReport;
  gates: ReturnType<typeof evaluateAgentBundleBaseline>;
}

export function agentBundleExitCode(value: AgentBundleEvaluation | Error): 0 | 1 | 2 {
  if (value instanceof Error) return 2;
  return value.gates.some((gate) => !gate.passed) ? 1 : agentEvalExitCode(value.report);
}

async function runAgentSuite(
  suite: AgentSuite,
  dependencies: AgentEvalDependencies,
  toolResolver: AgentToolResolver
): Promise<AgentSuiteReport> {
  const providers = new ProviderRegistry([
    new OpenAiResponsesAdapter({ fetcher: dependencies.fetcher }),
  ]);
  const runner = new AgentRunner({
    providers,
    async resolveCredential(ref) {
      if (!ref) return undefined;
      if (ref.source !== 'env')
        throw new Error('secret-handle credentials require the desktop keychain');
      return dependencies.environment[ref.name];
    },
    resolveTools: (sources) => toolResolver.resolve(sources),
  });
  return new AgentSuiteRunner({ run: (request) => runner.run(request) }).run({ suite });
}

export async function evaluateAgentSuite(
  suitePath: string,
  options: AgentEvalOptions = {},
  dependencies: AgentEvalDependencies = defaultDependencies
): Promise<AgentSuiteReport> {
  const suite = AgentSuiteSchema.parse(JSON.parse(await dependencies.readText(suitePath)));
  const toolResolver = createAgentToolResolver();
  preflightAgentSuite(suite, toolResolver);
  const report = await runAgentSuite(suite, dependencies, toolResolver);
  if (options.output)
    await dependencies.writeText(options.output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function evaluateAgentBundle(
  bundlePath: string,
  options: AgentEvalOptions = {},
  dependencies: AgentEvalDependencies = defaultDependencies
): Promise<AgentBundleEvaluation> {
  const bundle: AgentBundle = AgentBundleSchema.parse(
    JSON.parse(await dependencies.readText(bundlePath))
  );
  const toolResolver = createAgentToolResolver([createFixtureToolSourceAdapter(bundle.fixtures)]);
  preflightAgentSuite(bundle.suite, toolResolver);
  const report = await runAgentSuite(bundle.suite, dependencies, toolResolver);
  const gates = evaluateAgentBundleBaseline(bundle, report);
  const result = { report: applyAgentBundleBaseline(report, gates), gates };
  if (options.output)
    await dependencies.writeText(options.output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description('Run versioned agent suites in CI')
    .command('eval')
    .argument('<suite>', 'Path to an Agent Suite v2 or Agent Bundle v1 JSON file')
    .option('--output <file>', 'Write the full JSON trace report to a file')
    .action(async (suitePath: string, options: AgentEvalOptions) => {
      try {
        const input = JSON.parse(await defaultDependencies.readText(suitePath)) as Record<
          string,
          unknown
        >;
        if ('suite' in input && 'fixtures' in input) {
          const result = await evaluateAgentBundle(suitePath, options);
          process.stdout.write(
            `${JSON.stringify({ ...result.report.summary, gates: result.gates })}\n`
          );
          process.exitCode = agentBundleExitCode(result);
        } else {
          const report = await evaluateAgentSuite(suitePath, options);
          process.stdout.write(`${JSON.stringify(report.summary)}\n`);
          process.exitCode = agentEvalExitCode(report);
        }
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = agentEvalExitCode(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
}
