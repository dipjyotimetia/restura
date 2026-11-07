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
      allowMutations: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('stops the workflow cooperatively on SIGINT and removes its signal handlers', async () => {
    const deps = dependencies();
    let seen: AbortSignal | undefined;
    vi.mocked(deps.runOwsWorkspaceWorkflow).mockImplementation(async (_root, _id, options) => {
      seen = options.signal;
      process.emit('SIGINT', 'SIGINT');
      return { status: options.signal?.aborted ? 'stopped' : 'success', steps: [], variables: {} };
    });
    const before = process.listenerCount('SIGINT');
    await expect(
      executeOwsWorkflowCommand(
        './workspace',
        'billing',
        { timeout: '1000', allowLocalhost: false },
        deps
      )
    ).resolves.toBe(1);
    expect(seen?.aborted).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
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

  it('forwards an explicit mutation authorization to the workspace runner', async () => {
    const deps = dependencies();

    await executeOwsWorkflowCommand(
      './workspace',
      'billing',
      { timeout: '1000', allowLocalhost: false, allowMutations: true },
      deps
    );

    expect(deps.runOwsWorkspaceWorkflow).toHaveBeenCalledWith(
      './workspace',
      'billing',
      expect.objectContaining({ allowMutations: true })
    );
  });
});
