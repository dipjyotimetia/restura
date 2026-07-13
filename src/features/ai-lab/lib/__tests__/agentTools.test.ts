import { describe, expect, it } from 'vitest';
import { createResturaRequestTool } from '../agentTools';

describe('Restura request agent tools', () => {
  it('classifies reads and returns a structured response', async () => {
    const tool = createResturaRequestTool(
      {
        id: 'request-1',
        name: 'Get order',
        type: 'http',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      },
      async () => ({
        id: 'response',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{"paid":true}',
        time: 5,
        size: 13,
        requestId: 'request-1',
        timestamp: 0,
      })
    );
    expect(tool.permissionClass).toBe('read');
    expect(await tool.execute({}, { signal: new AbortController().signal })).toEqual([
      { type: 'json', value: expect.objectContaining({ status: 200, body: '{"paid":true}' }) },
    ]);
  });
});
