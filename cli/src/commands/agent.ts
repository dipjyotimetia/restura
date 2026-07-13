import { readFile, writeFile } from 'node:fs/promises';
import {
  AgentRunner,
  AgentSuiteRunner,
  AgentSuiteSchema,
  OpenAiResponsesAdapter,
  ProviderRegistry,
  type AgentSuiteReport,
} from '@shared/agent-lab';
import type { Command } from 'commander';
import { undiciFetcher } from '../runner/undiciFetcher.js';

export interface AgentEvalOptions {
  output?: string;
}

export async function evaluateAgentSuite(
  suitePath: string,
  options: AgentEvalOptions = {}
): Promise<AgentSuiteReport> {
  const suite = AgentSuiteSchema.parse(JSON.parse(await readFile(suitePath, 'utf8')));
  for (const agent of suite.agents) {
    if (agent.model.providerId !== 'openai.responses') {
      throw new Error(`headless provider adapter not registered: ${agent.model.providerId}`);
    }
    if (agent.model.baseUrl) {
      throw new Error(
        'headless agent eval refuses suite baseUrl overrides; configure a trusted adapter plugin'
      );
    }
    if (agent.tools.length) {
      throw new Error('headless tool sources require a registered CLI tool adapter');
    }
  }
  if (suite.graders.some((grader) => grader.kind === 'judge')) {
    throw new Error('headless judge graders require a registered CLI judge adapter');
  }
  const providers = new ProviderRegistry([new OpenAiResponsesAdapter({ fetcher: undiciFetcher })]);
  const runner = new AgentRunner({
    providers,
    async resolveCredential(ref) {
      if (!ref) return undefined;
      if (ref.source !== 'env')
        throw new Error('secret-handle credentials require the desktop keychain');
      return process.env[ref.name];
    },
    async resolveTools(sources) {
      if (sources.length > 0) {
        throw new Error('headless tool sources require a registered CLI tool adapter');
      }
      return [];
    },
  });
  const report = await new AgentSuiteRunner({ run: (request) => runner.run(request) }).run({
    suite,
  });
  if (options.output)
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description('Run versioned agent suites in CI')
    .command('eval')
    .argument('<suite>', 'Path to an Agent Suite v2 JSON file')
    .option('--output <file>', 'Write the full JSON trace report to a file')
    .action(async (suitePath: string, options: AgentEvalOptions) => {
      try {
        const report = await evaluateAgentSuite(suitePath, options);
        process.stdout.write(`${JSON.stringify(report.summary)}\n`);
        process.exitCode = report.status === 'passed' ? 0 : 1;
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
