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

const CHANGELOG_SECTION_TITLES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

type ChangelogSectionTitle = (typeof CHANGELOG_SECTION_TITLES)[number];

export interface ReleaseNoteSection {
  title: ChangelogSectionTitle;
  body: string;
  itemCount: number;
}

export interface ReleaseNoteExtraSection {
  title: string;
  body: string;
}

export interface ReleaseNoteContent {
  highlights: string | null;
  upgradeNotes: string | null;
  sections: ReleaseNoteSection[];
  contributors: string | null;
  extraSections: ReleaseNoteExtraSection[];
  preamble: string | null;
  fallbackBody: string | null;
}

interface FetchReleaseNotesOptions {
  channel: ReleaseNotesChannel;
  page?: number;
}

const pageCache = new Map<string, Promise<ReleaseNotesPage>>();

function topLevelListItemCount(markdown: string): number {
  return markdown.split('\n').filter((line) => /^(?:[-*+] |\d+\. )/.test(line)).length;
}

interface MarkdownSection {
  title: string;
  body: string;
}

interface ParsedMarkdownSections {
  preamble: string | null;
  sections: MarkdownSection[];
}

function markdownSections(markdown: string): ParsedMarkdownSections {
  const preambleLines: string[] = [];
  const sections: MarkdownSection[] = [];
  let activeFence: '`' | '~' | null = null;
  let title: string | null = null;
  let bodyLines: string[] = [];

  for (const line of markdown.split('\n')) {
    if (activeFence == null) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        if (title != null) sections.push({ title, body: bodyLines.join('\n').trim() });
        title = heading[1]!.trim();
        bodyLines = [];
        continue;
      }
    }

    if (title == null) preambleLines.push(line);
    else bodyLines.push(line);

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!fence) continue;

    const marker = fence[0] as '`' | '~';
    if (activeFence == null) activeFence = marker;
    else if (activeFence === marker) activeFence = null;
  }

  if (title != null) sections.push({ title, body: bodyLines.join('\n').trim() });

  return { preamble: preambleLines.join('\n').trim() || null, sections };
}

/**
 * Converts the documented release-body template into display sections while
 * retaining unstructured historical releases as Markdown fallback content.
 */
export function parseReleaseNoteContent(body: string): ReleaseNoteContent {
  const parsed = markdownSections(body);
  const { preamble, sections: parsedSections } = parsed;
  const sectionByTitle = new Map(
    parsedSections.map((section) => [section.title.toLowerCase(), section])
  );
  const highlights = sectionByTitle.get('highlights')?.body || null;
  const upgradeNotes = sectionByTitle.get('upgrade notes')?.body || null;
  const sections = CHANGELOG_SECTION_TITLES.flatMap((title) => {
    const section = sectionByTitle.get(title.toLowerCase());
    return section?.body
      ? [{ title, body: section.body, itemCount: topLevelListItemCount(section.body) }]
      : [];
  });
  const contributors = sectionByTitle.get('contributors')?.body || null;
  const recognizedTitles = new Set([
    'highlights',
    'upgrade notes',
    'contributors',
    ...CHANGELOG_SECTION_TITLES.map((title) => title.toLowerCase()),
  ]);
  const extraSections = parsedSections.filter(
    (section) => !recognizedTitles.has(section.title.toLowerCase())
  );
  const isStructured = parsedSections.length > 0;

  return {
    highlights,
    upgradeNotes,
    sections,
    contributors,
    extraSections,
    preamble: isStructured ? preamble : null,
    fallbackBody: isStructured ? null : body.trim() || null,
  };
}

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
