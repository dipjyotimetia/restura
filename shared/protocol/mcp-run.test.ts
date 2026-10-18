import { describe, expect, it } from 'vitest';
import {
  buildMcpRunReply,
  MAX_MCP_ERROR_TEXT,
  mcpMissingMethodMessage,
  mcpSessionKey,
  parseMcpRunParams,
} from './mcp-run';

describe('buildMcpRunReply (#901)', () => {
  it('wraps a plain result in the JSON-RPC envelope', () => {
    const reply = buildMcpRunReply({ result: { content: [] } });
    expect(reply.outcome).toBe('result');
    expect(reply.statusText).toBe('OK');
    expect(JSON.parse(reply.body)).toEqual({ jsonrpc: '2.0', result: { content: [] } });
  });

  it('classifies a tool result with isError: true as a tool error', () => {
    const reply = buildMcpRunReply({ result: { isError: true, content: [] } });
    expect(reply.outcome).toBe('tool-error');
    expect(reply.statusText).toBe('MCP tool error (isError: true)');
    expect(JSON.parse(reply.body).result.isError).toBe(true);
  });

  it('names the tool error with its text content (same wording as #868)', () => {
    const reply = buildMcpRunReply({
      result: {
        isError: true,
        content: [
          { type: 'text', text: 'boom' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'again' },
        ],
      },
    });
    expect(reply.statusText).toBe('MCP tool error (isError: true): boom\nagain');
  });

  it('truncates oversized server error text in the status line', () => {
    const big = 'x'.repeat(10_000);
    const tool = buildMcpRunReply({
      result: { isError: true, content: [{ type: 'text', text: big }] },
    });
    expect(tool.statusText.length).toBeLessThan(MAX_MCP_ERROR_TEXT + 100);
    expect(tool.statusText).toMatch(/truncated\)$/);
    const rpc = buildMcpRunReply({ error: { code: -1, message: big } });
    expect(rpc.statusText.length).toBeLessThan(MAX_MCP_ERROR_TEXT + 100);
    // The body (what scripts see) is untouched.
    expect(JSON.parse(rpc.body).error.message).toBe(big);
  });

  it('does not treat a truthy non-boolean isError as a tool error', () => {
    expect(buildMcpRunReply({ result: { isError: 'yes' } }).outcome).toBe('result');
  });

  it('normalises a missing result to null', () => {
    expect(JSON.parse(buildMcpRunReply({ result: undefined }).body)).toEqual({
      jsonrpc: '2.0',
      result: null,
    });
  });

  it('puts a JSON-RPC error under `error`, never `result`', () => {
    const reply = buildMcpRunReply({ error: { code: -32601, message: 'Method not found' } });
    expect(reply.outcome).toBe('jsonrpc-error');
    expect(reply.statusText).toBe('JSON-RPC error -32601: Method not found');
    const body = JSON.parse(reply.body);
    expect(body.error).toEqual({ code: -32601, message: 'Method not found' });
    expect(body).not.toHaveProperty('result');
  });
});

describe('parseMcpRunParams', () => {
  it('treats blank as no params', () => {
    expect(parseMcpRunParams(undefined)).toEqual({ ok: true, params: undefined });
    expect(parseMcpRunParams('  ')).toEqual({ ok: true, params: undefined });
  });

  it('parses objects and arrays', () => {
    expect(parseMcpRunParams('{"a":1}')).toEqual({ ok: true, params: { a: 1 } });
    expect(parseMcpRunParams('[1]')).toEqual({ ok: true, params: [1] });
  });

  it('rejects invalid JSON and scalar params', () => {
    expect(parseMcpRunParams('{oops')).toMatchObject({ ok: false, error: /not valid JSON/ });
    expect(parseMcpRunParams('"x"')).toMatchObject({ ok: false, error: /object or array/ });
    expect(parseMcpRunParams('null')).toMatchObject({ ok: false });
  });
});

describe('mcpSessionKey', () => {
  it('is stable across header order and name case', () => {
    expect(mcpSessionKey('u', 'streamable-http', { B: '2', a: '1' })).toBe(
      mcpSessionKey('u', 'streamable-http', { A: '1', b: '2' })
    );
  });

  it('differs by url, transport and header values', () => {
    const base = mcpSessionKey('u', 'streamable-http', { a: '1' });
    expect(mcpSessionKey('v', 'streamable-http', { a: '1' })).not.toBe(base);
    expect(mcpSessionKey('u', 'http-sse', { a: '1' })).not.toBe(base);
    expect(mcpSessionKey('u', 'streamable-http', { a: '2' })).not.toBe(base);
  });
});

it('mcpMissingMethodMessage names the request and the fields to set', () => {
  const msg = mcpMissingMethodMessage('Echo');
  expect(msg).toMatch(/"Echo"/);
  expect(msg).toMatch(/defaultMethod/);
  expect(msg).toMatch(/tools\/call/);
});
