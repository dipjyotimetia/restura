import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../provider';
import { ProviderRegistry } from '../provider';
import { AgentRunner, type AgentTool } from '../runner';
import type { AgentSuite } from '../types';

const adapter: ProviderAdapter = {
  id: 'fake',
  async discoverModels() {
    return [];
  },
  async getCapabilities() {
    throw new Error('not reached');
  },
  async generate() {
    throw new Error('not reached');
  },
};

function tool(description: string): AgentTool {
  return {
    definition: { name: 'shared_name', description, inputSchema: { type: 'object' } },
    permissionClass: 'read',
    async execute() {
      return [];
    },
  };
}

describe('AgentRunner duplicate tool names', () => {
  it('names both colliding tools in the error', async () => {
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'suite',
      name: 'Suite',
      mode: 'regression',
      agents: [
        {
          id: 'agent',
          model: { providerId: 'fake', model: 'model' },
          instructions: 'Use tools.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 10_000 },
        },
      ],
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'hi' }] }],
      graders: [],
      trials: 1,
    };
    const runner = new AgentRunner({
      providers: new ProviderRegistry([adapter]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [tool('GET Orders list'), tool('GET Orders export')];
      },
    });

    const result = await runner.run({ suite, taskId: 'task', agentId: 'agent', trial: 1 });

    expect(result.status).toBe('error');
    expect(result.error).toContain('duplicate resolved tool name: shared_name');
    expect(result.error).toContain('GET Orders list');
    expect(result.error).toContain('GET Orders export');
  });
});
