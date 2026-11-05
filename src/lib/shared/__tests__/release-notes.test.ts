import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearReleaseNotesCache,
  fetchReleaseNotesPage,
  parseReleaseNoteContent,
  RELEASE_FEED_URL,
} from '../release-notes';

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

/**
 * Stubs `fetch` so the static feed is unavailable (404) and everything else is
 * delegated to `apiMock`. `apiMock` therefore only ever sees GitHub API calls,
 * which is what the fallback-path tests assert on.
 */
function stubApiOnly(apiMock: (input: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    input === RELEASE_FEED_URL
      ? Promise.resolve(new Response('Not found', { status: 404 }))
      : Promise.resolve(apiMock(input, init))
  );
}

const feedRelease = (id: number, tag: string, prerelease = false) => ({
  id,
  tag_name: tag,
  name: tag,
  body: `Notes ${tag}`,
  html_url: `https://github.com/dipjyotimetia/restura/releases/tag/${tag}`,
  published_at: '2026-07-01T12:00:00Z',
  prerelease,
});

function feedResponse(feedReleases: unknown[], version = 1) {
  return new Response(JSON.stringify({ version, generated_at: 'now', releases: feedReleases }), {
    status: 200,
  });
}

describe('fetchReleaseNotesPage', () => {
  afterEach(() => {
    clearReleaseNotesCache();
    vi.unstubAllGlobals();
  });

  describe('static release feed', () => {
    it('serves the stable channel from the feed without touching the GitHub API', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          feedResponse([feedRelease(3, 'v1.3.0-beta.1', true), feedRelease(2, 'v1.2.0')])
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toEqual({
        releases: [
          {
            id: 2,
            tag: 'v1.2.0',
            name: 'v1.2.0',
            body: 'Notes v1.2.0',
            url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.2.0',
            publishedAt: '2026-07-01T12:00:00Z',
            isPrerelease: false,
          },
        ],
        nextPage: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        RELEASE_FEED_URL,
        expect.objectContaining({ credentials: 'omit' })
      );
    });

    it('includes prereleases for beta and downloads the feed once for all pages', async () => {
      const many = Array.from({ length: 35 }, (_, i) => feedRelease(100 - i, `v1.${100 - i}.0`));
      const fetchMock = vi.fn().mockResolvedValue(feedResponse(many));
      vi.stubGlobal('fetch', fetchMock);

      const first = await fetchReleaseNotesPage({ channel: 'beta' });
      expect(first.releases).toHaveLength(30);
      expect(first.nextPage).toBe(2);

      const second = await fetchReleaseNotesPage({ channel: 'beta', page: 2 });
      expect(second.releases).toHaveLength(5);
      expect(second.nextPage).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the GitHub API when the feed payload is invalid', async () => {
      const fetchMock = vi.fn(async (input: string) =>
        input === RELEASE_FEED_URL
          ? feedResponse([feedRelease(2, 'v1.2.0')], 2) // unknown feed version
          : new Response(JSON.stringify([releases[1]]), { status: 200 })
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toMatchObject({
        releases: [expect.objectContaining({ tag: 'v1.2.0', body: 'Stable changes' })],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects a feed whose links point outside this repository', async () => {
      const evil = { ...feedRelease(2, 'v1.2.0'), html_url: 'https://evil.example/releases/1' };
      const fetchMock = vi.fn(async (input: string) =>
        input === RELEASE_FEED_URL
          ? feedResponse([evil])
          : new Response(JSON.stringify([releases[1]]), { status: 200 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const page = await fetchReleaseNotesPage({ channel: 'stable' });
      expect(page.releases[0]?.url).toBe(
        'https://github.com/dipjyotimetia/restura/releases/tag/v1.2.0'
      );
    });

    it('falls back to the GitHub API when the feed host is unreachable', async () => {
      const fetchMock = vi.fn(async (input: string) => {
        if (input === RELEASE_FEED_URL) throw new TypeError('network down');
        return new Response(JSON.stringify([releases[1]]), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toMatchObject({
        releases: [expect.objectContaining({ tag: 'v1.2.0' })],
      });
    });

    it('surfaces the API rate-limit message only after the feed has also failed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) =>
          input === RELEASE_FEED_URL
            ? new Response('nope', { status: 500 })
            : new Response('{}', { status: 429 })
        )
      );

      await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow(/hourly limit/);
    });

    it('refetches the feed after a failed load', async () => {
      let feedCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          if (input !== RELEASE_FEED_URL) return new Response('{}', { status: 500 });
          feedCalls += 1;
          return feedCalls === 1
            ? new Response('boom', { status: 500 })
            : feedResponse([feedRelease(2, 'v1.2.0')]);
        })
      );

      await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow();
      await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toMatchObject({
        releases: [expect.objectContaining({ tag: 'v1.2.0' })],
      });
      expect(feedCalls).toBe(2);
    });
  });

  it('returns only published stable releases for the stable channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: { Link: '' },
      })
    );
    stubApiOnly(fetchMock);

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
      nextPage: null,
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
    stubApiOnly(fetchMock);

    const options = { channel: 'beta' as const };
    await expect(fetchReleaseNotesPage(options)).resolves.toMatchObject({
      releases: [
        expect.objectContaining({ tag: 'v1.3.0-beta.1', isPrerelease: true }),
        expect.objectContaining({ tag: 'v1.2.0', isPrerelease: false }),
      ],
      nextPage: 2,
    });
    await fetchReleaseNotesPage(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/dipjyotimetia/restura/releases?per_page=30&page=1',
      expect.objectContaining({ headers: { Accept: 'application/vnd.github+json' } })
    );
  });

  it('skips source pages without stable releases and returns the following source page', async () => {
    const prereleaseOnly = [releases[0]];
    const stableOnly = [releases[1]];
    const fetchMock = vi.fn(async (input: string) => {
      const page = new URL(input).searchParams.get('page');
      if (page === '1') {
        return new Response(JSON.stringify(prereleaseOnly), {
          status: 200,
          headers: {
            Link: '<https://api.github.com/repos/dipjyotimetia/restura/releases?page=2>; rel="next"',
          },
        });
      }
      return new Response(JSON.stringify(stableOnly), {
        status: 200,
        headers: {
          Link: '<https://api.github.com/repos/dipjyotimetia/restura/releases?page=3>; rel="next"',
        },
      });
    });
    stubApiOnly(fetchMock);

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toMatchObject({
      releases: [expect.objectContaining({ tag: 'v1.2.0' })],
      nextPage: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid GitHub responses with a user-safe error', async () => {
    stubApiOnly(
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'nope' }), { status: 403 }))
    );

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow(
      'Release notes are unavailable right now. Please try again.'
    );
  });

  it('names an exhausted GitHub rate limit and when it resets', async () => {
    const reset = Math.floor(new Date(2026, 10, 2, 18, 5).getTime() / 1000);
    stubApiOnly(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) },
        })
      )
    );
    const time = new Date(reset * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow(
      `GitHub's hourly limit for requests from your network has been reached. Try again after ${time}, or read the release notes on GitHub.`
    );
  });

  it('treats a 429 without a reset header as a rate limit', async () => {
    stubApiOnly(vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).rejects.toThrow(
      /hourly limit .* Try again later,/
    );
  });
});

describe('parseReleaseNoteContent', () => {
  it('extracts the curated sections from the release-note template', () => {
    expect(
      parseReleaseNoteContent(`## Highlights

- **MCP:** Reconnects preserve in-flight tool state.
- **Desktop:** DNS validation now runs before native connections.

## Upgrade notes

- No action required.

## Added

- **AI Lab:** Added task-aware graders.

## Fixed

- **HTTP:** Fixed redirect handling.

## Contributors

Thanks to @octocat.`)
    ).toEqual({
      highlights:
        '- **MCP:** Reconnects preserve in-flight tool state.\n- **Desktop:** DNS validation now runs before native connections.',
      upgradeNotes: '- No action required.',
      sections: [
        {
          title: 'Added',
          body: '- **AI Lab:** Added task-aware graders.',
          itemCount: 1,
        },
        {
          title: 'Fixed',
          body: '- **HTTP:** Fixed redirect handling.',
          itemCount: 1,
        },
      ],
      contributors: 'Thanks to @octocat.',
      extraSections: [],
      preamble: null,
      footer: null,
      fallbackBody: null,
    });
  });

  it('keeps legacy release bodies available as a fallback', () => {
    expect(parseReleaseNoteContent('A free-form legacy release body.')).toEqual({
      highlights: null,
      upgradeNotes: null,
      sections: [],
      contributors: null,
      extraSections: [],
      preamble: null,
      footer: null,
      fallbackBody: 'A free-form legacy release body.',
    });
  });

  it('retains prose and unrecognized sections from structured release bodies', () => {
    expect(
      parseReleaseNoteContent(`## Highlights

An overview before the list.

- First item
  - Nested detail

## Known issues

Read [the issue tracker](https://example.com/issues) before upgrading.`)
    ).toEqual({
      highlights: 'An overview before the list.\n\n- First item\n  - Nested detail',
      upgradeNotes: null,
      sections: [],
      contributors: null,
      extraSections: [
        {
          title: 'Known issues',
          body: 'Read [the issue tracker](https://example.com/issues) before upgrading.',
        },
      ],
      preamble: null,
      footer: null,
      fallbackBody: null,
    });
  });

  it('retains Markdown before the first structured heading', () => {
    expect(
      parseReleaseNoteContent(`# v1.2.0

Upgrade your agent configuration before installing this release.

## Fixed

- Restored request history.`)
    ).toEqual({
      highlights: null,
      upgradeNotes: null,
      sections: [{ title: 'Fixed', body: '- Restored request history.', itemCount: 1 }],
      contributors: null,
      extraSections: [],
      preamble: '# v1.2.0\n\nUpgrade your agent configuration before installing this release.',
      footer: null,
      fallbackBody: null,
    });
  });

  it('does not split sections on headings inside fenced code blocks', () => {
    expect(
      parseReleaseNoteContent(`## Fixed

Use this configuration:

\`\`\`md
## Configure
enabled: true
\`\`\``)
    ).toEqual({
      highlights: null,
      upgradeNotes: null,
      sections: [
        {
          title: 'Fixed',
          body: 'Use this configuration:\n\n```md\n## Configure\nenabled: true\n```',
          itemCount: 0,
        },
      ],
      contributors: null,
      extraSections: [],
      preamble: null,
      footer: null,
      fallbackBody: null,
    });
  });

  it('parses the git-cliff body that release.yml publishes', () => {
    const commit = '([`5d16189`](https://github.com/dipjyotimetia/restura/commit/5d16189))';
    expect(
      parseReleaseNoteContent(`## 1.14.0 — 2026-10-31

## Added

- Custom close code ${commit}

- Unified streaming timeline ${commit}


## Fixed

- Base64 IPC for desktop binary frames ${commit}


---
A CycloneDX SBOM of the production dependency tree is attached
(\`restura.cdx.json\` / \`.xml\`).
`)
    ).toEqual({
      highlights: null,
      upgradeNotes: null,
      sections: [
        {
          title: 'Added',
          body: `- Custom close code ${commit}\n\n- Unified streaming timeline ${commit}`,
          itemCount: 2,
        },
        {
          title: 'Fixed',
          body: `- Base64 IPC for desktop binary frames ${commit}`,
          itemCount: 1,
        },
      ],
      contributors: null,
      extraSections: [],
      preamble: null,
      footer:
        'A CycloneDX SBOM of the production dependency tree is attached\n(`restura.cdx.json` / `.xml`).',
      fallbackBody: null,
    });
  });

  it('keeps a thematic break inside a section when another heading follows', () => {
    expect(
      parseReleaseNoteContent('## Fixed\n\n- One\n\n---\n\n- Two\n\n## Security\n\n- Three')
    ).toEqual(
      expect.objectContaining({
        sections: [
          { title: 'Fixed', body: '- One\n\n---\n\n- Two', itemCount: 2 },
          { title: 'Security', body: '- Three', itemCount: 1 },
        ],
        footer: null,
      })
    );
  });
});
