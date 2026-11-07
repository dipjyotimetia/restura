import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { applyAgentToolWithUndo, describeProposal } from '../proposalPreview';
import { runAgentTool } from '../tools';

const P = '[REDACTED]';

function open(extra: Partial<HttpRequest> = {}): void {
  useRequestStore.getState().openTab(
    {
      id: 'r1',
      name: 'Base',
      type: 'http',
      method: 'GET',
      url: 'https://api.example/a',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      ...extra,
    },
    { switchTo: true }
  );
}

function active(): HttpRequest {
  const st = useRequestStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId)?.request as HttpRequest;
}

const run = (tool: string, input: unknown) => runAgentTool(tool, JSON.stringify(input));

beforeEach(() => {
  useRequestStore.setState({ tabs: [], activeTabId: null });
});

describe('update_http_request edge cases', () => {
  it('replaces an enabled header value in place and appends duplicate keys', () => {
    open({ headers: [{ id: 'h1', key: 'Accept', value: 'text/plain', enabled: true }] });
    const res = run('update_http_request', {
      headers: [
        { key: 'accept', value: 'application/json' },
        { key: 'X-Dup', value: '1' },
        { key: 'x-dup', value: '2' },
      ],
    });
    expect(res.ok).toBe(true);
    const headers = active().headers.map((h) => [h.key, h.value]);
    expect(headers).toEqual([
      ['Accept', 'application/json'],
      ['X-Dup', '1'],
      ['x-dup', '2'],
    ]);
    expect(active().headers[0]?.id).toBe('h1');
  });

  it('merges params by exact (trimmed) key and keeps disabled rows', () => {
    open({
      params: [
        { id: 'p1', key: 'page', value: '1', enabled: true },
        { id: 'p2', key: 'debug', value: 'x', enabled: false },
      ],
    });
    const res = run('update_http_request', { params: [{ key: ' page ', value: '2' }] });
    expect(res).toMatchObject({ ok: true, summary: 'Updated the active request (params)' });
    expect(active().params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '2', true],
      ['debug', 'x', false],
    ]);
  });

  it('keeps the URL when the proposal redacted it and says nothing was applied', () => {
    open();
    const res = run('update_http_request', { url: `https://api.example/${P}` });
    expect(res).toEqual({
      ok: false,
      error: `Nothing was applied: the proposed url contained the ${P} placeholder, so the current value was kept`,
    });
    expect(active().url).toBe('https://api.example/a');
  });

  it('applies the other fields and notes the kept URL', () => {
    open();
    const res = run('update_http_request', { url: `https://x/${P}`, name: 'Renamed' });
    expect(res).toEqual({
      ok: true,
      summary: 'Updated the active request (name); kept the current url (redacted in the proposal)',
    });
    expect(active().name).toBe('Renamed');
  });

  it('turns a non-raw body into json when replacing it', () => {
    open({ body: { type: 'form-data', formData: [] } });
    expect(run('update_http_request', { body: '{"a":1}' }).ok).toBe(true);
    expect(active().body).toEqual({ type: 'json', raw: '{"a":1}' });
  });

  it('refuses a denylisted method', () => {
    open();
    const res = run('update_http_request', { method: 'TRACE' });
    expect(res.ok).toBe(false);
    expect(active().method).toBe('GET');
  });
});

describe('other tools edge cases', () => {
  it('create_http_request refuses a denylisted method', () => {
    const res = run('create_http_request', { method: 'CONNECT', url: 'https://x' });
    expect(res.ok).toBe(false);
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('enrich_docs validates input and needs an active HTTP request', () => {
    expect(run('enrich_docs', { documentation: '' }).ok).toBe(false);
    expect(run('enrich_docs', { documentation: 'Docs' })).toEqual({
      ok: false,
      error: 'No active HTTP request to document',
    });
    open();
    expect(run('enrich_docs', { documentation: '# Users' }).ok).toBe(true);
    expect(active().description).toBe('# Users');
  });
});

describe('describeProposal edge cases', () => {
  it('returns no changes for non-object input', () => {
    expect(describeProposal('update_http_request', '[1,2]', null)).toEqual({
      title: 'Update the active request',
      changes: [],
      suppressed: false,
    });
    expect(describeProposal('update_http_request', 'null', null).changes).toEqual([]);
  });

  it('create_http_request: defaults the method, lists headers and body, skips bad pairs', () => {
    const p = describeProposal(
      'create_http_request',
      JSON.stringify({
        name: 'New',
        headers: [{ key: 'A', value: '1' }, { key: 'B' }, null, 'junk'],
        body: '{}',
      }),
      null
    );
    expect(p.changes).toEqual([
      { label: 'Request', after: 'GET' },
      { label: 'Name', after: 'New' },
      { label: 'Header A', after: '1' },
      { label: 'Body', after: '{}' },
    ]);
  });

  it('update: hides an unchanged field and a redacted header value', () => {
    open({
      headers: [
        { id: 'h1', key: 'Authorization', value: 'Bearer secret', enabled: true },
        { id: 'h2', key: 'Off', value: 'x', enabled: false },
      ],
    });
    const p = describeProposal(
      'update_http_request',
      JSON.stringify({
        url: 'https://api.example/a',
        headers: [{ key: 'authorization', value: P }],
      }),
      active()
    );
    expect(p.changes).toEqual([]);
    expect(p.suppressed).toBe(true);
  });

  it('update: shows param changes keyed exactly, and a redacted new param is suppressed', () => {
    open({ params: [{ id: 'p1', key: 'page', value: '1', enabled: true }] });
    const p = describeProposal(
      'update_http_request',
      JSON.stringify({
        params: [
          { key: 'page', value: '2' },
          { key: 'token', value: P },
        ],
      }),
      active()
    );
    expect(p.changes).toEqual([{ label: 'Param page', before: '1', after: '2' }]);
    expect(p.suppressed).toBe(true);
  });

  it('update with no active request treats every field as added', () => {
    const p = describeProposal(
      'update_http_request',
      JSON.stringify({ method: 'post', headers: [{ key: 'A', value: '1' }], params: [] }),
      null
    );
    expect(p.changes).toEqual([
      { label: 'Method', after: 'POST' },
      { label: 'Header A', after: '1' },
    ]);
  });
});

describe('applyAgentToolWithUndo edge cases', () => {
  it('returns no undo when the tool failed', () => {
    const out = applyAgentToolWithUndo('update_http_request', '{"url":"https://x"}');
    expect(out.result.ok).toBe(false);
    expect(out.undo).toBeUndefined();
  });

  it('create: undo closes the opened tab, and is a no-op once it is gone', () => {
    open();
    const out = applyAgentToolWithUndo('create_http_request', '{"url":"https://new.example"}');
    expect(out.result.ok).toBe(true);
    expect(useRequestStore.getState().tabs).toHaveLength(2);
    const opened = useRequestStore.getState().activeTabId as string;
    useRequestStore.getState().closeTab(opened);
    out.undo?.();
    expect(useRequestStore.getState().tabs).toHaveLength(1);
  });

  it('create from a non-HTTP active tab still offers an undo', () => {
    useRequestStore.getState().openTab(
      {
        id: 'g1',
        name: 'g',
        type: 'grpc',
        url: 'localhost:50051',
        service: '',
        method: '',
        metadata: [],
        message: '{}',
      } as never,
      { switchTo: true }
    );
    // create still opens (and can undo) a new tab even from a non-HTTP tab.
    const out = applyAgentToolWithUndo('create_http_request', '{"url":"https://new.example"}');
    expect(out.result.ok).toBe(true);
    expect(typeof out.undo).toBe('function');
  });
});
