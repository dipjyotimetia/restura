import { describe, it, expect, beforeEach } from 'vitest';
import { runAgentTool, agentToolDefs } from '../tools';
import { useRequestStore } from '@/store/useRequestStore';

beforeEach(() => {
  useRequestStore.setState({ tabs: [], activeTabId: null });
});

describe('agentToolDefs', () => {
  it('exposes tool definitions with JSON schemas', () => {
    const defs = agentToolDefs();
    expect(defs.map((d) => d.name)).toContain('create_http_request');
    expect(defs.every((d) => d.inputSchema && typeof d.inputSchema === 'object')).toBe(true);
  });
});

describe('create_http_request', () => {
  it('opens a new HTTP tab from a tool call', () => {
    const res = runAgentTool(
      'create_http_request',
      JSON.stringify({ method: 'post', url: 'https://api.example/users', body: '{"a":1}' })
    );
    expect(res.ok).toBe(true);
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    expect(tab?.request.type).toBe('http');
    if (tab?.request.type === 'http') {
      expect(tab.request.method).toBe('POST');
      expect(tab.request.url).toBe('https://api.example/users');
      expect(tab.request.body.raw).toBe('{"a":1}');
    }
  });

  it('rejects invalid input', () => {
    expect(runAgentTool('create_http_request', 'not json').ok).toBe(false);
    expect(runAgentTool('create_http_request', JSON.stringify({ method: 'GET' })).ok).toBe(false); // missing url
  });
});

describe('set_test_script', () => {
  it('updates the active HTTP request test script', () => {
    runAgentTool('create_http_request', JSON.stringify({ url: 'https://api.example/x' }));
    const res = runAgentTool(
      'set_test_script',
      JSON.stringify({ script: "pm.test('ok', () => {});" })
    );
    expect(res.ok).toBe(true);
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (tab?.request.type === 'http') {
      expect(tab.request.testScript).toContain('pm.test');
    }
  });

  it('errors when there is no active HTTP request', () => {
    const res = runAgentTool('set_test_script', JSON.stringify({ script: 'x' }));
    expect(res.ok).toBe(false);
  });
});

describe('update_http_request', () => {
  it('updates url, method, and headers of the active request', () => {
    runAgentTool('create_http_request', JSON.stringify({ url: 'https://old.example' }));
    const res = runAgentTool(
      'update_http_request',
      JSON.stringify({
        url: 'https://new.example',
        method: 'post',
        headers: [{ key: 'X-Test', value: '1' }],
      })
    );
    expect(res.ok).toBe(true);
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (tab?.request.type === 'http') {
      expect(tab.request.url).toBe('https://new.example');
      expect(tab.request.method).toBe('POST');
      expect(tab.request.headers.map((h) => h.key)).toContain('X-Test');
    }
  });

  it('leaves omitted fields untouched', () => {
    runAgentTool(
      'create_http_request',
      JSON.stringify({ url: 'https://keep.example', method: 'PUT' })
    );
    runAgentTool('update_http_request', JSON.stringify({ url: 'https://changed.example' }));
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (tab?.request.type === 'http') {
      expect(tab.request.url).toBe('https://changed.example');
      expect(tab.request.method).toBe('PUT'); // unchanged
    }
  });

  it('rejects an empty update and when there is no active HTTP request', () => {
    expect(runAgentTool('update_http_request', JSON.stringify({})).ok).toBe(false);
    expect(runAgentTool('update_http_request', JSON.stringify({ url: 'x' })).ok).toBe(false);
  });
});

describe('enrich_docs', () => {
  it('sets the description of the active request', () => {
    runAgentTool('create_http_request', JSON.stringify({ url: 'https://api.example/docs' }));
    const res = runAgentTool(
      'enrich_docs',
      JSON.stringify({ documentation: '## Users\nReturns all users.' })
    );
    expect(res.ok).toBe(true);
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (tab?.request.type === 'http') {
      expect(tab.request.description).toContain('Returns all users');
    }
  });

  it('errors when there is no active HTTP request', () => {
    expect(runAgentTool('enrich_docs', JSON.stringify({ documentation: 'x' })).ok).toBe(false);
  });
});

describe('runAgentTool', () => {
  it('rejects unknown tools', () => {
    expect(runAgentTool('nope', '{}')).toEqual({ ok: false, error: 'Unknown tool: nope' });
  });
});
