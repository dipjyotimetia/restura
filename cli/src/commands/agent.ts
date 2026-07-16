import { readFile, writeFile } from 'node:fs/promises';
import {
  AgentRunner,
  type AgentSuite,
  type AgentSuiteReport,
  AgentSuiteRunner,
  AgentSuiteSchema,
  AnthropicMessagesAdapter,
  migrateAgentSuite,
  OpenAiResponsesAdapter,
  ProviderRegistry,
} from '@shared/agent-lab';
import type { Fetcher } from '@shared/protocol/types';
import type commander from 'commander';
import { loadEnv } from '../runner/envLoader.js';
import { executeHttp } from '../runner/executors/http.js';
import { loadCollection } from '../runner/collectionLoader.js';
import { resolveCliAgentTools } from '../runner/agentTools.js';
import { resolveCliGrounding } from '../runner/agentGrounding.js';
import { undiciFetcher } from '../runner/undiciFetcher.js';
import { AgentRuntimeManifestSchema, type AgentRuntimeManifest } from './agentRuntime.js';

export interface AgentEvalOptions {
  output?: string;
  runtime?: string;
  env?: string;
  timeout?: string;
  allowLocalhost?: boolean;
}

export interface AgentEvalDependencies {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  fetcher: Fetcher;
  environment: Readonly<Record<string, string | undefined>>;
  loadEnvironment(path: string): Promise<Record<string, string>>;
  loadCollection: typeof loadCollection;
  executeHttp: typeof executeHttp;
}

const defaultDependencies: AgentEvalDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  writeText: async (path, content) => {
    await writeFile(path, content, 'utf8');
  },
  fetcher: undiciFetcher,
  environment: process.env,
  loadEnvironment: (path) => loadEnv(path, { expandEnvVars: true }),
  loadCollection,
  executeHttp,
};

export function preflightAgentSuite(suite: AgentSuite, runtime?: AgentRuntimeManifest): void {
  for (const agent of suite.agents) {
    if (!['openai.responses', 'anthropic.messages'].includes(agent.model.providerId)) {
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

  if (suite.agents.some((agent) => agent.tools.length > 0) && !runtime) {
    throw new Error('headless tool sources require a runtime manifest');
  }
  for (const agent of suite.agents) {
    for (const source of agent.tools) {
      if (source.kind === 'restura-request') {
        const allowed = runtime?.sources.some(
          (candidate) =>
            candidate.kind === 'collection' && candidate.requestIds.includes(source.requestId)
        );
        if (!allowed) {
          throw new Error(
            `request tool is not listed in the runtime manifest: ${source.requestId}`
          );
        }
      } else if (source.kind === 'mcp') {
        const mcp = runtime?.sources.find(
          (candidate) => candidate.kind === 'mcp' && candidate.id === source.connectionId
        );
        if (!mcp || mcp.kind !== 'mcp') {
          throw new Error(
            `MCP tool source is not listed in the runtime manifest: ${source.connectionId}`
          );
        }
        if (source.allowedTools?.some((tool) => !mcp.allowedTools.includes(tool))) {
          throw new Error(
            `MCP tool source exceeds the runtime manifest allowlist: ${source.connectionId}`
          );
        }
      } else {
        throw new Error('headless tool sources require a registered CLI tool adapter');
      }
    }
  }
  if (suite.graders.some((grader) => grader.kind === 'judge')) {
    throw new Error('headless judge graders require a registered CLI judge adapter');
  }
}

export function agentEvalExitCode(value: AgentSuiteReport | Error): 0 | 1 | 2 {
  if (value instanceof Error) return 2;
  return value.status === 'passed' ? 0 : 1;
}

export async function evaluateAgentSuite(
  suitePath: string,
  options: AgentEvalOptions = {},
  dependencies: AgentEvalDependencies = defaultDependencies
): Promise<AgentSuiteReport> {
  const suite = migrateAgentSuite(
    AgentSuiteSchema.parse(JSON.parse(await dependencies.readText(suitePath)))
  );
  const runtime = options.runtime
    ? AgentRuntimeManifestSchema.parse(JSON.parse(await dependencies.readText(options.runtime)))
    : undefined;
  preflightAgentSuite(suite, runtime);
  const variables = options.env ? await dependencies.loadEnvironment(options.env) : {};
  const timeoutMs = numericFlag('--timeout', options.timeout ?? '30000');
  const providers = new ProviderRegistry([
    new OpenAiResponsesAdapter({ fetcher: dependencies.fetcher }),
    new AnthropicMessagesAdapter({ fetcher: dependencies.fetcher }),
  ]);
  const runner = new AgentRunner({
    providers,
    async resolveCredential(ref) {
      if (!ref) return undefined;
      if (ref.source !== 'env')
        throw new Error('secret-handle credentials require the desktop keychain');
      return dependencies.environment[ref.name];
    },
    async resolveTools(sources, signal) {
      if (sources.length === 0) return [];
      if (!runtime) throw new Error('headless tool sources require a runtime manifest');
      return resolveCliAgentTools(
        sources,
        runtime,
        {
          variables,
          environment: dependencies.environment,
          timeoutMs,
          allowLocalhost: Boolean(options.allowLocalhost),
          ...(signal ? { signal } : {}),
        },
        {
          loadCollection: dependencies.loadCollection,
          executeHttp: dependencies.executeHttp,
        }
      );
    },
    async resolveGrounding(selection, signal) {
      if (!runtime) throw new Error('headless grounding requires a runtime manifest');
      return resolveCliGrounding(
        selection,
        runtime,
        {
          environment: dependencies.environment,
          allowLocalhost: Boolean(options.allowLocalhost),
          timeoutMs,
          ...(signal ? { signal } : {}),
        },
        { loadCollection: dependencies.loadCollection }
      );
    },
  });
  const report = await new AgentSuiteRunner({ run: (request) => runner.run(request) }).run({
    suite,
  });
  if (options.output)
    await dependencies.writeText(options.output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function registerAgentCommand(program: commander.Command): void {
  program
    .command('agent')
    .description('Run versioned agent suites in CI')
    .command('eval')
    .argument('<suite>', 'Path to an Agent Suite v2 or v3 JSON file')
    .option('--output <file>', 'Write the full JSON trace report to a file')
    .option('--runtime <file>', 'Runtime manifest binding selected saved HTTP and MCP sources')
    .option('--env <file>', 'Path to env file (json or yaml) used by saved requests')
    .option('--timeout <ms>', 'Per saved HTTP request timeout', '30000')
    .option('--allow-localhost', 'Permit localhost saved request targets (off by default)', false)
    .action(async (suitePath: string, options: AgentEvalOptions) => {
      try {
        const report = await evaluateAgentSuite(suitePath, options);
        process.stdout.write(`${JSON.stringify(report.summary)}\n`);
        process.exitCode = agentEvalExitCode(report);
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = agentEvalExitCode(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
}

function numericFlag(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`${name} expects a positive number, got: ${value}`);
  }
  return number;
}
