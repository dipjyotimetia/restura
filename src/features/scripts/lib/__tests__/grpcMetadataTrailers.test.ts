/**
 * #910 — gRPC scripts can read response metadata + trailers, and pre-request
 * scripts can mutate outgoing metadata through `rs.request.metadata`.
 */
import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

const grpcResponse = {
  status: 0,
  statusText: 'OK',
  headers: { 'x-foo': 'bar', 'content-type': 'application/grpc' },
  trailers: { 'grpc-status': '0', 'x-trace': 'abc' },
  body: '{"message":"hi"}',
  time: 5,
  size: 16,
};

describe('ScriptExecutor — gRPC response metadata + trailers (#910)', () => {
  it('exposes response headers, trailers and the metadata alias to test scripts', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(
      `
      rs.test('header', () => rs.expect(rs.response.headers.get('x-foo')).to.equal('bar'));
      rs.test('raw header', () => rs.expect(response.headers['x-foo']).to.equal('bar'));
      rs.test('metadata alias', () => rs.expect(rs.response.metadata.get('X-Foo')).to.equal('bar'));
      rs.test('trailer', () => rs.expect(rs.response.trailers.get('x-trace')).to.equal('abc'));
      rs.test('trailer has', () => rs.expect(rs.response.trailers.has('grpc-status', '0')).to.equal(true));
      rs.test('trailer object', () => rs.expect(rs.response.trailers.toObject()).to.deep.equal({ 'grpc-status': '0', 'x-trace': 'abc' }));
      rs.test('raw trailers', () => rs.expect(response.trailers['grpc-status']).to.equal('0'));
      `,
      { request: { url: 'http://h', method: 'unary', headers: {} }, response: grpcResponse }
    );
    expect(result.errors).toEqual([]);
    expect(result.tests?.every((t) => t.passed)).toBe(true);
    expect(result.tests).toHaveLength(7);
  });

  it('rs.response.trailers is empty (not throwing) when the response has none', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(
      `rs.test('none', () => rs.expect(rs.response.trailers.get('x')).to.equal(undefined));`,
      {
        response: { status: 200, statusText: 'OK', headers: {}, body: '', time: 1, size: 0 },
      }
    );
    expect(result.tests?.[0]?.passed).toBe(true);
  });
});

describe('ScriptExecutor — pre-request metadata mutation (#910)', () => {
  const request = () => ({
    url: 'http://h',
    method: 'unary',
    headers: { 'x-a': '1' },
    metadata: { 'x-a': '1' },
  });

  it('reports rs.request.metadata edits as requestMetadata', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(
      `
      rs.request.metadata['x-new'] = 'v-' + 2;
      delete rs.request.metadata['x-a'];
      `,
      { request: request() }
    );
    expect(result.errors).toEqual([]);
    expect(result.requestMetadata).toEqual({ 'x-new': 'v-2' });
  });

  it('request.headers is a live alias of request.metadata', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(
      `request.headers['x-b'] = 'b'; rs.request.headers = { 'x-c': 'c' };`,
      { request: request() }
    );
    expect(result.requestMetadata).toEqual({ 'x-c': 'c' });
  });

  it('coerces values to strings and ignores non-object reassignment', async () => {
    const exec = new ScriptExecutor();
    const coerced = await exec.executeScript(`rs.request.metadata['x-n'] = 42;`, {
      request: request(),
    });
    expect(coerced.requestMetadata).toEqual({ 'x-a': '1', 'x-n': '42' });

    const bogus = await new ScriptExecutor().executeScript(`rs.request.metadata = 'nope';`, {
      request: request(),
    });
    expect(bogus.requestMetadata).toBeUndefined();
  });

  it('omits requestMetadata when the script did not change it', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(`console.log(rs.request.metadata['x-a']);`, {
      request: request(),
    });
    expect(result.logs.some((l) => l.message === '1')).toBe(true);
    expect(result.requestMetadata).toBeUndefined();
  });

  it('does not report metadata for protocols that did not supply it (HTTP)', async () => {
    const exec = new ScriptExecutor();
    const result = await exec.executeScript(`request.headers['x-z'] = '1';`, {
      request: { url: 'http://h', method: 'GET', headers: {} },
    });
    expect(result.requestMetadata).toBeUndefined();
  });

  it('keeps only scalar entries and never lets a script smuggle in __proto__', async () => {
    const result = await new ScriptExecutor().executeScript(
      `
      var m = JSON.parse('{"__proto__": "polluted"}');
      m['x-a'] = '1';
      m['x-flag'] = true;
      m['x-obj'] = { nested: 1 };
      m['x-list'] = ['a'];
      rs.request.metadata = m;
      `,
      { request: request() }
    );
    expect(result.errors).toEqual([]);
    expect(result.requestMetadata).toEqual({ 'x-a': '1', 'x-flag': 'true' });
    expect(Object.getPrototypeOf(result.requestMetadata)).toBe(Object.prototype);
  });

  it('ignores metadata the sandbox cannot serialise (cyclic object)', async () => {
    const result = await new ScriptExecutor().executeScript(
      `var m = { 'x-a': '2' }; m.self = m; rs.request.metadata = m;`,
      { request: request() }
    );
    expect(result.requestMetadata).toBeUndefined();
  });
});
