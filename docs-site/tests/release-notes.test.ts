import { afterEach, describe, expect, it, vi } from 'vitest';
import { initReleaseNotes, releaseMarkup } from '../src/scripts/release-notes';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function fixture() {
  document.body.innerHTML =
    '<p id="release-status"></p><div id="release-items"></div><button id="release-more" hidden></button>';
}
describe('release notes', () => {
  it('focuses the first newly loaded release on the final page', async () => {
    fixture();
    const firstPage = Array.from({ length: 10 }, (_, id) => ({
      id,
      tag_name: `v${id}`,
      body: 'Notes',
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 11, tag_name: 'older', body: 'Older notes' }],
      });
    vi.stubGlobal('fetch', fetcher);
    initReleaseNotes();
    await vi.waitFor(() => expect(document.querySelectorAll('article')).toHaveLength(10));
    const button = document.querySelector<HTMLButtonElement>('#release-more');
    button?.focus();
    button?.click();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('older'));
    expect(button?.hidden).toBe(true);
    expect(document.querySelector('#release-status')?.textContent).toContain('1 release loaded');
    expect(fetcher.mock.calls[1]?.[0]).toContain('page=2');
  });
  it('keeps formatting but strips executable markup and unsafe URLs', () => {
    const host = document.createElement('div');
    host.append(
      releaseMarkup(
        '<h1>Changes</h1><p onclick="alert(1)"><strong>Fix</strong><a href="javascript:alert(1)">bad</a><a href="https://github.com/a">safe</a></p><script>alert(1)</script><img src=x onerror=alert(1)>'
      )
    );
    expect(host.querySelector('h3')?.textContent).toBe('Changes');
    expect(host.querySelector('strong')?.textContent).toBe('Fix');
    expect(host.querySelector('script,img,[onclick],[onerror]')).toBeNull();
    expect(host.querySelectorAll('a')[0]?.hasAttribute('href')).toBe(false);
    expect(host.querySelectorAll('a')[1]?.href).toBe('https://github.com/a');
  });
  it('fetches without credentials and renders API notes', async () => {
    fixture();
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 1,
          tag_name: 'v1',
          name: '<script>title</script>',
          body_html: '<ul><li>Fixed requests</li></ul>',
          published_at: '2026-10-08',
          prerelease: true,
        },
      ],
    });
    vi.stubGlobal('fetch', fetcher);
    initReleaseNotes();
    await vi.waitFor(() =>
      expect(document.querySelector('li')?.textContent).toBe('Fixed requests')
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github.full+json' },
    });
    expect(document.querySelector('h2')?.textContent).toBe('<script>title</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('#release-more')?.hasAttribute('hidden')).toBe(true);
  });
  it('retries the same page after a rate limit and shows the empty state', async () => {
    fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetcher);
    initReleaseNotes();
    await vi.waitFor(() =>
      expect(document.querySelector('#release-status')?.textContent).toContain('rate-limited')
    );
    document.querySelector<HTMLButtonElement>('#release-more')?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('#release-status')?.textContent).toContain('No releases')
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(fetcher.mock.calls[1]?.[0]);
  });
});
