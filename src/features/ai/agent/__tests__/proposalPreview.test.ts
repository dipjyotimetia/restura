import { beforeEach, describe, expect, it } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { applyAgentToolWithUndo, describeProposal } from '../proposalPreview';

function activeHttp(): HttpRequest {
  const st = useRequestStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  if (tab?.request.type !== 'http') throw new Error('no active http tab');
  return tab.request;
}

function openBase(): HttpRequest {
  const req: HttpRequest = {
    id: 'r1',
    name: 'Users',
    type: 'http',
    method: 'GET',
    url: 'https://api.example/users',
    headers: [
      { id: 'h1', key: 'Accept', value: 'application/json', enabled: true },
      { id: 'h2', key: 'X-Old', value: '1', enabled: true },
    ],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    testScript: "rs.test('old', () => {});",
  };
  useRequestStore.getState().openTab(req, { switchTo: true });
  return activeHttp();
}

beforeEach(() => {
  useRequestStore.setState({ tabs: [], activeTabId: null });
});

describe('describeProposal', () => {
  it('gives each tool a human-readable title', () => {
    expect(describeProposal('create_http_request', '{"url":"https://x"}', null).title).toBe(
      'Create a new request'
    );
    expect(describeProposal('set_test_script', '{"script":"x"}', null).title).toBe(
      'Replace the test script'
    );
    expect(describeProposal('update_http_request', '{"url":"https://x"}', null).title).toBe(
      'Update the active request'
    );
    expect(describeProposal('enrich_docs', '{"documentation":"x"}', null).title).toBe(
      'Set the request documentation'
    );
    expect(describeProposal('mystery_tool', '{}', null).title).toBe('mystery_tool');
  });

  it('shows the old and new test script', () => {
    const req = openBase();
    const p = describeProposal('set_test_script', JSON.stringify({ script: 'new()' }), req);
    expect(p.changes).toEqual([
      { label: 'Test script', before: "rs.test('old', () => {});", after: 'new()' },
    ]);
  });

  it('lists headers added, removed and changed, and url before→after', () => {
    const req = openBase();
    const p = describeProposal(
      'update_http_request',
      JSON.stringify({
        url: 'https://api.example/v2/users',
        headers: [
          { key: 'Accept', value: 'text/plain' },
          { key: 'X-New', value: 'y' },
        ],
      }),
      req
    );
    expect(p.changes).toEqual([
      { label: 'URL', before: 'https://api.example/users', after: 'https://api.example/v2/users' },
      { label: 'Header Accept', before: 'application/json', after: 'text/plain' },
      { label: 'Header X-Old', before: '1' },
      { label: 'Header X-New', after: 'y' },
    ]);
  });

  it('falls back to no changes for unparseable input', () => {
    expect(describeProposal('set_test_script', 'not json', null).changes).toEqual([]);
  });
});

describe('applyAgentToolWithUndo', () => {
  it('undo restores the previous request after update_http_request', () => {
    openBase();
    const before = activeHttp();
    const { result, undo } = applyAgentToolWithUndo(
      'update_http_request',
      JSON.stringify({ url: 'https://changed', headers: [{ key: 'X-New', value: 'y' }] })
    );
    expect(result.ok).toBe(true);
    expect(activeHttp().url).toBe('https://changed');
    expect(undo).toBeTypeOf('function');
    undo?.();
    const after = activeHttp();
    expect(after.url).toBe(before.url);
    expect(after.headers).toEqual(before.headers);
  });

  it('undo restores the previous test script', () => {
    openBase();
    const { undo } = applyAgentToolWithUndo('set_test_script', JSON.stringify({ script: 'n()' }));
    expect(activeHttp().testScript).toBe('n()');
    undo?.();
    expect(activeHttp().testScript).toBe("rs.test('old', () => {});");
  });

  it('undo closes the tab opened by create_http_request', () => {
    const { result, undo } = applyAgentToolWithUndo(
      'create_http_request',
      JSON.stringify({ url: 'https://new' })
    );
    expect(result.ok).toBe(true);
    expect(useRequestStore.getState().tabs).toHaveLength(1);
    undo?.();
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('offers no undo when the tool failed', () => {
    const { result, undo } = applyAgentToolWithUndo('set_test_script', '{}');
    expect(result.ok).toBe(false);
    expect(undo).toBeUndefined();
  });
});
