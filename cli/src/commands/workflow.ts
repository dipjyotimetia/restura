import type { Command } from 'commander';
import { loadEnv } from '../runner/envLoader.js';
import { runOwsWorkspaceWorkflow } from '../runner/owsWorkspaceRunner.js';

export interface OwsWorkflowCommandOpts {
  env?: string;
  timeout: string;
  allowLocalhost: boolean;
}

export interface OwsWorkflowCommandDependencies {
  loadEnv: typeof loadEnv;
  runOwsWorkspaceWorkflow: typeof runOwsWorkspaceWorkflow;
}

const defaultDependencies: OwsWorkflowCommandDependencies = {
  loadEnv,
  runOwsWorkspaceWorkflow,
};

function positiveTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout expects a positive number, got: ${value}`);
  }
  return timeout;
}

/**
 * Execute the public CLI OWS surface. The runner itself owns parsing,
 * profile validation, binding resolution, and protocol dispatch; this command
 * deliberately only supplies CLI-owned options and environment values.
 */
export async function executeOwsWorkflowCommand(
  workspace: string,
  workflowId: string,
  opts: OwsWorkflowCommandOpts,
  dependencies: OwsWorkflowCommandDependencies = defaultDependencies
): Promise<0 | 1> {
  const variables = opts.env ? await dependencies.loadEnv(opts.env, { expandEnvVars: true }) : {};
  const result = await dependencies.runOwsWorkspaceWorkflow(workspace, workflowId, {
    variables,
    timeoutMs: positiveTimeout(opts.timeout),
    allowLocalhost: Boolean(opts.allowLocalhost),
  });
  return result.status === 'success' ? 0 : 1;
}

/** Register `restura workflow run <workspace> <workflow-id>`. */
export function registerWorkflowCommand(program: Command): void {
  program
    .command('workflow')
    .description('Discover and run a validated OWS workflow from an OpenCollection workspace')
    .command('run')
    .description('Run a binding-only OWS workflow')
    .argument('<workspace>', 'OpenCollection workspace directory containing opencollection.yml')
    .argument('<workflow-id>', 'Portable workflow artifact identifier')
    .option('--env <file>', 'Path to env file (json or yaml)')
    .option('--timeout <ms>', 'Workflow timeout cap', '30000')
    .option('--allow-localhost', 'Permit localhost / 127.0.0.1 targets (off by default)', false)
    .action(async (workspace: string, workflowId: string, opts: OwsWorkflowCommandOpts) => {
      try {
        process.exitCode = await executeOwsWorkflowCommand(workspace, workflowId, opts);
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
