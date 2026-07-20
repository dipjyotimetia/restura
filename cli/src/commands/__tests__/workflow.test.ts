import { describe, expect, it, vi } from 'vitest';
import { executeOwsWorkflowCommand, type OwsWorkflowCommandDependencies } from '../workflow';

function dependencies(): OwsWorkflowCommandDependencies {
  return {
    loadEnv: vi.fn().mockResolvedValue({ TOKEN: 'from-file' }),
    runOwsWorkspaceWorkflow: vi.fn().mockResolvedValue({
      status: 'success',
      steps: [],
      variables: {},
    }),
  };
}

describe('OWS workflow CLI command', () => {
  it('loads approved environment variables and invokes the fail-closed OWS workspace runner', async () => {
    const deps = dependencies();

    await expect(
      executeOwsWorkflowCommand(
        './workspace',
        'billing',
        { env: './ci.env', timeout: '1500', allowLocalhost: false },
        deps
      )
    ).resolves.toBe(0);

    expect(deps.loadEnv).toHaveBeenCalledWith('./ci.env', { expandEnvVars: true });
    expect(deps.runOwsWorkspaceWorkflow).toHaveBeenCalledWith('./workspace', 'billing', {
      variables: { TOKEN: 'from-file' },
      timeoutMs: 1500,
      allowLocalhost: false,
    });
  });

  it('returns a failure exit code for a validated workflow that fails at runtime', async () => {
    const deps = dependencies();
    vi.mocked(deps.runOwsWorkspaceWorkflow).mockResolvedValue({
      status: 'failed',
      steps: [],
      variables: {},
    });

    await expect(
      executeOwsWorkflowCommand(
        './workspace',
        'billing',
        { timeout: '1000', allowLocalhost: false },
        deps
      )
    ).resolves.toBe(1);
  });

  it('rejects invalid timeouts before opening a workspace', async () => {
    const deps = dependencies();

    await expect(
      executeOwsWorkflowCommand(
        './workspace',
        'billing',
        { timeout: 'zero', allowLocalhost: false },
        deps
      )
    ).rejects.toThrow('--timeout expects a positive number');
    expect(deps.runOwsWorkspaceWorkflow).not.toHaveBeenCalled();
  });
});
