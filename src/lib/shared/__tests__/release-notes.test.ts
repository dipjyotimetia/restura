import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearReleaseNotesCache, fetchReleaseNotesPage } from '../release-notes';

const releases = [
  {
    id: 3,
    tag_name: 'v1.3.0-beta.1',
    name: 'v1.3.0-beta.1',
    body: 'Beta changes',
    html_url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.3.0-beta.1',
    published_at: '2026-07-10T12:00:00Z',
    draft: false,
    prerelease: true,
  },
  {
    id: 2,
    tag_name: 'v1.2.0',
    name: 'v1.2.0',
    body: 'Stable changes',
    html_url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.2.0',
    published_at: '2026-07-01T12:00:00Z',
    draft: false,
    prerelease: false,
  },
  {
    id: 1,
    tag_name: 'v1.1.0',
    name: 'Draft',
    body: 'Never show this',
    html_url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.1.0',
    published_at: null,
    draft: true,
    prerelease: false,
  },
];

describe('fetchReleaseNotesPage', () => {
  afterEach(() => {
    clearReleaseNotesCache();
    vi.unstubAllGlobals();
  });

  it('returns only published stable releases for the stable channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: { Link: '' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toEqual({
      releases: [
        {
          id: 2,
          tag: 'v1.2.0',
          name: 'v1.2.0',
          body: 'Stable changes',
          url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.2.0',
          publishedAt: '2026-07-01T12:00:00Z',
          isPrerelease: false,
        },
      ],
      hasNextPage: false,
    });
  });

  it('includes published prereleases for the beta channel and caches the page for the session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: {
          Link: '<https://api.github.com/repos/dipjyotimetia/restura/releases?page=2>; rel="next"',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const options = { channel: 'beta' as const };
    await expect(fetchReleaseNotesPage(options)).resolves.toMatchObject({
      releases: [
        expect.objectContaining({ tag: 'v1.3.0-beta.1', isPrerelease: true }),
        expect.objectContaining({ tag: 'v1.2.0', isPrerelease: false }),
      ],
      hasNextPage: true,
    });
    await fetchReleaseNotesPage(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dipjyotimetia/restura/releases?per_page=30&page=1',
      expect.objectContaining({ headers: { Accept: 'application/vnd.github+json' } })
    );
  });

  it('rejects invalid GitHub responses with a user-safe error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'nope' }), { status: 403 }))
    );

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow(
      'Release notes are unavailable right now. Please try again.'
    );
  });
});
