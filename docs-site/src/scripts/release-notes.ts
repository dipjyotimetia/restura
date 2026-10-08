const endpoint = 'https://api.github.com/repos/dipjyotimetia/restura/releases';
const allowedTags = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'STRONG',
  'EM',
  'DEL',
  'CODE',
  'PRE',
  'BLOCKQUOTE',
  'BR',
  'HR',
  'A',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
]);

// Remote release HTML is untrusted: rebuild an inert tree with only text,
// formatting, and HTTPS links. Never insert the API response as live HTML.
export function releaseMarkup(html: string): DocumentFragment {
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  const fragment = document.createDocumentFragment();
  function copy(source: Node, target: Node): void {
    if (source.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(source.textContent ?? ''));
      return;
    }
    if (!(source instanceof Element)) return;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH'].includes(source.tagName)) return;
    let destination = target;
    if (allowedTags.has(source.tagName)) {
      const element = document.createElement(
        /^H[1-6]$/.test(source.tagName) ? 'h3' : source.tagName.toLowerCase()
      );
      if (element instanceof HTMLAnchorElement) {
        try {
          const url = new URL(source.getAttribute('href') ?? '', 'https://github.com');
          if (url.protocol === 'https:') element.href = url.href;
        } catch {
          /* Keep invalid links as text. */
        }
        element.rel = 'noopener noreferrer';
      }
      target.appendChild(element);
      destination = element;
    }
    for (const child of source.childNodes) copy(child, destination);
  }
  for (const child of parsed.content.childNodes) copy(child, fragment);
  return fragment;
}

export function initReleaseNotes(): void {
  const items = document.querySelector<HTMLElement>('#release-items');
  const status = document.querySelector<HTMLElement>('#release-status');
  const more = document.querySelector<HTMLButtonElement>('#release-more');
  if (!items || !status || !more) return;
  let page = 1;
  let loading = false;
  const seen = new Set<number>();
  async function load(userTriggered = false): Promise<void> {
    if (!items || !status || !more || loading) return;
    loading = true;
    more.disabled = true;
    items.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading release notes…';
    try {
      const response = await fetch(`${endpoint}?per_page=10&page=${page}`, {
        credentials: 'omit',
        headers: { Accept: 'application/vnd.github.full+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 403 || response.status === 429
            ? 'GitHub’s public API is temporarily rate-limited. Please try again later.'
            : 'Release notes could not be loaded. Please try again.'
        );
      const data: unknown = await response.json();
      if (!Array.isArray(data))
        throw new Error('GitHub returned an unexpected response. Please try again.');
      let firstTitle: HTMLElement | undefined;
      let added = 0;
      for (const release of data) {
        if (
          !release ||
          typeof release.id !== 'number' ||
          typeof release.tag_name !== 'string' ||
          release.draft ||
          seen.has(release.id)
        )
          continue;
        const article = document.createElement('article');
        const title = document.createElement('h2');
        title.tabIndex = -1;
        firstTitle ??= title;
        added += 1;
        title.textContent =
          typeof release.name === 'string' && release.name ? release.name : release.tag_name;
        const meta = document.createElement('p');
        meta.className = 'release-meta';
        const date = new Date(release.published_at);
        meta.textContent = `${release.tag_name}${Number.isNaN(date.getTime()) ? '' : ` · ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`}${release.prerelease ? ' · Pre-release' : ''}`;
        const notes = document.createElement('div');
        if (typeof release.body_html === 'string' && release.body_html)
          notes.append(releaseMarkup(release.body_html));
        else {
          notes.className = 'release-plain';
          notes.textContent =
            typeof release.body === 'string' && release.body
              ? release.body
              : 'No release notes were provided.';
        }
        article.append(title, meta, notes);
        items.append(article);
        seen.add(release.id);
      }
      page += 1;
      more.hidden = data.length < 10;
      more.textContent = 'Load older releases';
      status.textContent = seen.size
        ? `${added} release${added === 1 ? '' : 's'} loaded.${more.hidden ? ' You’re up to date.' : ''}`
        : 'No releases have been published yet.';
      if (userTriggered) {
        if (firstTitle) firstTitle.focus();
        else if (more.hidden) {
          status.tabIndex = -1;
          status.focus();
        }
      }
    } catch (error) {
      status.textContent =
        error instanceof Error && error.name === 'Error'
          ? error.message
          : 'Unable to reach GitHub. Check your connection and try again.';
      more.hidden = false;
      more.textContent = 'Try again';
    } finally {
      loading = false;
      more.disabled = false;
      items.setAttribute('aria-busy', 'false');
    }
  }
  more.addEventListener('click', () => {
    void load(true);
  });
  void load();
}
