// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { __test_handleDeepLink } from '../lifecycle/deep-link-handler';

type Sent = { host: string; params: Record<string, string> };

function makeWin() {
  const sent: Sent[] = [];
  const win = {
    webContents: { send: (_ch: string, msg: Sent) => sent.push(msg) },
  } as unknown as Electron.BrowserWindow;
  return { sent, getWin: () => win };
}

describe('handleDeepLink url-param validation', () => {
  it('drops `url` param pointing at private IP', () => {
    const { sent, getWin } = makeWin();
    __test_handleDeepLink('restura://import?url=http://169.254.169.254/x', getWin);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.url).toBeUndefined();
  });

  it('drops `url` param pointing at localhost', () => {
    const { sent, getWin } = makeWin();
    __test_handleDeepLink('restura://import?url=http://localhost:6443/api', getWin);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.url).toBeUndefined();
  });

  it('drops `url` param with javascript: scheme', () => {
    const { sent, getWin } = makeWin();
    __test_handleDeepLink('restura://import?url=javascript:alert(1)', getWin);
    expect(sent[0]!.params.url).toBeUndefined();
  });

  it('preserves a valid public url', () => {
    const { sent, getWin } = makeWin();
    __test_handleDeepLink('restura://import?url=https://example.com/foo.json', getWin);
    expect(sent[0]!.params.url).toBe('https://example.com/foo.json');
  });

  it('ignores unknown deep-link hosts', () => {
    const { sent, getWin } = makeWin();
    __test_handleDeepLink('restura://attacker?url=https://example.com', getWin);
    expect(sent).toHaveLength(0);
  });

  it('truncates non-URL params to 1024 chars', () => {
    const { sent, getWin } = makeWin();
    const longValue = 'a'.repeat(2000);
    __test_handleDeepLink(`restura://collection?name=${longValue}`, getWin);
    expect(sent[0]!.params.name?.length).toBe(1024);
  });
});
