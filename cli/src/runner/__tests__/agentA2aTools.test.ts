import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeManifest } from '../../commands/agentRuntime.js';
import { AgentPreflightError } from '../agentPreflightError.js';
import { resolveCliAgentTools } from '../agentTools.js';

const pinnedFetch = vi.hoisted(() => vi.fn<typeof globalThis.fetch>());
const createSession = vi.hoisted(() => vi.fn());
vi.mock('../pinnedMcpFetch.js', () => ({ createPinnedMcpFetchSession: createSession }));
vi.mock('../agentMcpClient.js', () => ({ connectCliMcpClient: vi.fn() }));

const endpoint = 'https://agent.example';
const runtime: AgentRuntimeManifest = {
  schemaVersion: 1,
  sources: [
    {
      id: 'planner',
      kind: 'a2a',
      endpoint,
      readOnly: true,
      headers: [{ name: 'authorization', env: 'PLANNER_TOKEN' }],
    },
  ],
};
const deps = { loadCollection: vi.fn(), executeHttp: vi.fn() };
const options = (environment: Record<string, string>) => ({
  variables: {},
  environment,
  timeoutMs: 5_000,
  allowLocalhost: false,
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe('resolveCliAgentTools A2A sources (#1043)', () => {
  it('calls a manifest-listed agent over the pinned session with env headers', async () => {
    const dispose = vi.fn();
    createSession.mockReturnValue({ fetch: pinnedFetch, fetcher: vi.fn(), dispose });
    pinnedFetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') {
        return json({ name: 'Planner', url: `${endpoint}/rpc` });
      }
      return json({
        jsonrpc: '2.0',
        id: '1',
        result: { kind: 'message', parts: [{ kind: 'text', text: `ok ${String(input)}` }] },
      });
    });

    const resolved = await resolveCliAgentTools(
      [{ kind: 'a2a', endpoint }],
      runtime,
      options({ PLANNER_TOKEN: 'Bearer t' }),
      deps
    );

    expect(createSession).toHaveBeenCalledWith(false);
    const [tool] = resolved.tools;
    expect(tool?.definition.name).toBe('a2a_Planner');
    expect(tool?.permissionClass).toBe('read');
    const output = await tool!.execute({ message: 'hi' }, { signal: new AbortController().signal });
    expect(output[0]).toEqual({ type: 'text', text: `ok ${endpoint}/rpc` });
    const headers = pinnedFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    await resolved.dispose?.();
    expect(dispose).toHaveBeenCalled();
  });

  it('refuses a missing header variable as a preflight error and disposes the session', async () => {
    const dispose = vi.fn();
    createSession.mockReturnValue({ fetch: pinnedFetch, fetcher: vi.fn(), dispose });
    await expect(
      resolveCliAgentTools([{ kind: 'a2a', endpoint }], runtime, options({}), deps)
    ).rejects.toBeInstanceOf(AgentPreflightError);
    expect(dispose).toHaveBeenCalled();
  });

  it('refuses an endpoint the manifest does not list', async () => {
    createSession.mockReturnValue({ fetch: pinnedFetch, fetcher: vi.fn(), dispose: vi.fn() });
    await expect(
      resolveCliAgentTools(
        [{ kind: 'a2a', endpoint: 'https://other.example' }],
        runtime,
        options({ PLANNER_TOKEN: 't' }),
        deps
      )
    ).rejects.toThrow(/not a read-only runtime binding/);
  });
});
