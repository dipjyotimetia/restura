/**
 * Reading a pre-request script's `request.headers` / `request.metadata` edits
 * back out of the QuickJS sandbox: only real, well-formed edits are reported,
 * so the host rewrites the outgoing request only when a script changed it.
 */
import { describe, expect, it } from 'vitest';
import ScriptExecutor from './script-executor';
import { applyScriptHeaderEdits } from './script-executor-request';
import type { ScriptContext } from './script-executor-types';

async function run(script: string, request?: ScriptContext['request']) {
  const executor = new ScriptExecutor();
  try {
    return await executor.executeScript(script, request ? { request } : {});
  } finally {
    executor.dispose();
  }
}

type BoundRequest = NonNullable<ScriptContext['request']>;

const httpRequest = (): BoundRequest => ({
  url: 'https://api.example.com',
  method: 'GET',
  headers: { Accept: 'text/plain' },
});

const grpcRequest = (): BoundRequest => {
  const metadata = { 'x-tenant': 'acme' };
  return { url: 'http://h:1', method: 'unary', headers: metadata, metadata };
};

describe('readRequestHeaders', () => {
  it('reports nothing when no request is bound', async () => {
    const result = await run(`console.log('no request');`);
    expect(result.errors).toEqual([]);
    expect(result.requestHeaders).toBeUndefined();
  });

  it.each([
    ['null', 'request.headers = null;'],
    ['an array', "request.headers = ['a'];"],
    ['a string', "request.headers = 'Accept: x';"],
  ])('ignores headers replaced with %s', async (_label, script) => {
    const result = await run(script, httpRequest());
    expect(result.errors).toEqual([]);
    expect(result.requestHeaders).toBeUndefined();
  });

  it('keeps scalar values as strings and drops empty, __proto__ and non-scalar entries', async () => {
    const result = await run(
      `request.headers['X-Num'] = 7;
       request.headers['X-Bool'] = true;
       request.headers['X-Obj'] = { nested: 1 };
       request.headers[''] = 'empty name';
       Object.defineProperty(request.headers, '__proto__', { value: 'p', enumerable: true });`,
      httpRequest()
    );
    expect(result.errors).toEqual([]);
    expect(result.requestHeaders).toEqual({ Accept: 'text/plain', 'X-Num': '7', 'X-Bool': 'true' });
  });

  it('reports a changed value, and nothing when a value is rewritten unchanged', async () => {
    const changed = await run(`request.headers['Accept'] = 'application/json';`, httpRequest());
    expect(changed.requestHeaders).toEqual({ Accept: 'application/json' });
    const same = await run(`request.headers['Accept'] = 'text/plain';`, httpRequest());
    expect(same.requestHeaders).toBeUndefined();
  });

  it('a request bound without headers reports any header the script adds', async () => {
    const { headers: _omit, ...bare } = httpRequest();
    const result = await run(
      `request.headers = { 'X-New': 'n' };`,
      bare as ScriptContext['request']
    );
    expect(result.requestHeaders).toEqual({ 'X-New': 'n' });
  });

  it('does not read headers for a gRPC request (its headers are the metadata)', async () => {
    const result = await run(`request.metadata['x-extra'] = 'e';`, grpcRequest());
    expect(result.requestHeaders).toBeUndefined();
    expect(result.requestMetadata).toEqual({ 'x-tenant': 'acme', 'x-extra': 'e' });
  });
});

describe('readRequestMetadata', () => {
  it.each([
    ['null', 'request.metadata = null;'],
    ['an array', 'request.metadata = [1];'],
  ])('ignores metadata replaced with %s', async (_label, script) => {
    const result = await run(script, grpcRequest());
    expect(result.errors).toEqual([]);
    expect(result.requestMetadata).toBeUndefined();
  });

  it('coerces scalars and drops __proto__ and object values', async () => {
    const result = await run(
      `request.metadata['x-n'] = 1;
       request.metadata['x-o'] = {};
       Object.defineProperty(request.metadata, '__proto__', { value: 'p', enumerable: true });`,
      grpcRequest()
    );
    expect(result.requestMetadata).toEqual({ 'x-tenant': 'acme', 'x-n': '1' });
  });

  it('reports a changed value, and nothing when the script leaves metadata as it was', async () => {
    const changed = await run(`request.metadata['x-tenant'] = 'other';`, grpcRequest());
    expect(changed.requestMetadata).toEqual({ 'x-tenant': 'other' });
    const same = await run(`request.metadata['x-tenant'] = 'acme';`, grpcRequest());
    expect(same.requestMetadata).toBeUndefined();
  });

  it('reports a removed entry', async () => {
    const result = await run(`delete request.metadata['x-tenant'];`, grpcRequest());
    expect(result.requestMetadata).toEqual({});
  });
});

describe('applyScriptHeaderEdits — rows outside the script view', () => {
  const ids = () => {
    let n = 0;
    return () => `new-${++n}`;
  };

  it('leaves disabled rows alone, even when the script sets the same name', () => {
    const rows = [{ id: '1', key: 'X-A', value: 'off', enabled: false }];
    expect(applyScriptHeaderEdits(rows, {}, { 'X-A': 'on' }, ids())).toEqual([
      rows[0],
      { id: 'new-1', key: 'X-A', value: 'on', enabled: true },
    ]);
  });

  it('does not append a header an enabled row already carries outside the script view', () => {
    // A row the host left out of the script's map (e.g. an auto header) keeps
    // its own value; the script's same-named entry is not duplicated.
    const rows = [{ id: '1', key: 'X-Host', value: 'host', enabled: true }];
    expect(applyScriptHeaderEdits(rows, {}, { 'x-host': 'script' }, ids())).toEqual(rows);
  });
});
