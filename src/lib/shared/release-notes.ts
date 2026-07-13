import { z } from 'zod';

const RELEASES_URL = 'https://api.github.com/repos/dipjyotimetia/restura/releases';
const PAGE_SIZE = 30;

const GitHubReleaseSchema = z.object({
  id: z.number().int(),
  tag_name: z.string().min(1),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.url(),
  published_at: z.string().datetime().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

const GitHubReleasesSchema = z.array(GitHubReleaseSchema);

export type ReleaseNotesChannel = 'stable' | 'beta';

export interface ReleaseNote {
  id: number;
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string;
  isPrerelease: boolean;
}

export interface ReleaseNotesPage {
  releases: ReleaseNote[];
  nextPage: number | null;
}

interface FetchReleaseNotesOptions {
  channel: ReleaseNotesChannel;
  page?: number;
}

const pageCache = new Map<string, Promise<ReleaseNotesPage>>();

function cacheKey({ channel, page = 1 }: FetchReleaseNotesOptions): string {
  return `${channel}:${page}`;
}

function getNextPage(linkHeader: string | null): number | null {
  const nextLink = linkHeader?.split(',').find((link) => /rel="next"/.test(link));
  const url = nextLink?.match(/<([^>]+)>/)?.[1];
  if (!url) return null;

  try {
    const page = Number(new URL(url).searchParams.get('page'));
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

async function requestReleaseNotes({
  channel,
  page = 1,
}: FetchReleaseNotesOptions): Promise<ReleaseNotesPage> {
  let currentPage = page;

  while (true) {
    const url = new URL(RELEASES_URL);
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(currentPage));

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: 'application/vnd.github+json' },
      });
    } catch {
      throw new Error('Release notes are unavailable right now. Please try again.');
    }

    if (!response.ok) {
      throw new Error('Release notes are unavailable right now. Please try again.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Release notes are unavailable right now. Please try again.');
    }

    const parsed = GitHubReleasesSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Release notes are unavailable right now. Please try again.');
    }

    const releases = parsed.data
      .filter((release) => !release.draft && release.published_at != null)
      .filter((release) => channel === 'beta' || !release.prerelease)
      .map((release) => ({
        id: release.id,
        tag: release.tag_name,
        name: release.name?.trim() || release.tag_name,
        body: release.body ?? '',
        url: release.html_url,
        publishedAt: release.published_at!,
        isPrerelease: release.prerelease,
      }));
    const nextPage = getNextPage(response.headers.get('Link'));

    if (nextPage == null || nextPage <= currentPage) {
      return { releases, nextPage: null };
    }

    if (releases.length > 0) {
      return { releases, nextPage };
    }

    currentPage = nextPage;
  }
}

/**
 * Fetch one public GitHub Releases page and keep it only for this app session.
 * Failed requests are deliberately not cached so the UI's Retry button always
 * performs a fresh request.
 */
export function fetchReleaseNotesPage(
  options: FetchReleaseNotesOptions
): Promise<ReleaseNotesPage> {
  const key = cacheKey(options);
  const cached = pageCache.get(key);
  if (cached) return cached;

  const request = requestReleaseNotes(options).catch((error: unknown) => {
    pageCache.delete(key);
    throw error;
  });
  pageCache.set(key, request);
  return request;
}

export function clearReleaseNotesCache(): void {
  pageCache.clear();
}
