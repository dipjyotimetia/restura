import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';
import { PRE_REQUEST_TEMPLATE, TEST_SCRIPT_TEMPLATE } from '../scriptTemplates';

describe('Scripts editor templates', () => {
  it('the default test script passes every test against a fast 200 response', async () => {
    const result = await new ScriptExecutor({ envVars: {} }).executeScript(TEST_SCRIPT_TEMPLATE, {
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        time: 120,
        size: 11,
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.tests?.length).toBeGreaterThan(0);
    expect(result.tests?.filter((t) => !t.passed)).toEqual([]);
  });

  it('the default test script fails its status test on a 500', async () => {
    const result = await new ScriptExecutor({ envVars: {} }).executeScript(TEST_SCRIPT_TEMPLATE, {
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: {},
        body: '',
        time: 120,
        size: 0,
      },
    });
    expect(result.tests?.find((t) => t.name === 'Status code is 200')?.passed).toBe(false);
  });

  it('the default pre-request script runs cleanly', async () => {
    const result = await new ScriptExecutor({ envVars: {} }).executeScript(PRE_REQUEST_TEMPLATE, {
      request: { url: 'https://api.example.com', method: 'GET', headers: {} },
    });
    expect(result.errors).toEqual([]);
  });
});
