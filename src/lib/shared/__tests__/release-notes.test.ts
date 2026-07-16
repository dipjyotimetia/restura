import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearReleaseNotesCache,
  fetchReleaseNotesPage,
  parseReleaseNoteContent,
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
    vi.stubGlobal('fetch', fetchMock);

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
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchReleaseNotesPage({ channel: 'stable' })).resolves.toMatchObject({
      releases: [expect.objectContaining({ tag: 'v1.2.0' })],
      nextPage: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      fallbackBody: null,
    });
  });
});
