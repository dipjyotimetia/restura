import type { LoadedRequest } from './collectionLoader.js';

export interface FilterOptions {
  /** Only include requests whose folderPath starts with this (slash-joined). */
  folder?: string;
  /** Repeatable: keep requests whose name or relativePath matches any pattern. */
  include?: string[];
  /** Repeatable: drop requests whose name or relativePath matches any pattern. Applied after include. */
  exclude?: string[];
}

/**
 * Apply --folder / --include / --exclude filters in one pass. Patterns
 * support a minimal subset of glob: `*` matches any segment chars except `/`,
 * `**` matches any chars including `/`. Plain substrings without wildcards
 * are treated as substring matches against name + relativePath.
 */
export function applyFilters(requests: LoadedRequest[], opts: FilterOptions): LoadedRequest[] {
  const folder = opts.folder?.replace(/^\/+|\/+$/g, '');
  const includes = (opts.include ?? []).map(compile);
  const excludes = (opts.exclude ?? []).map(compile);

  return requests.filter((r) => {
    if (folder) {
      const path = r.folderPath.join('/');
      if (path !== folder && !path.startsWith(`${folder}/`)) return false;
    }
    const haystacks = [r.request.name, r.relativePath];
    if (includes.length > 0 && !includes.some((re) => haystacks.some((h) => re.test(h)))) {
      return false;
    }
    if (excludes.length > 0 && excludes.some((re) => haystacks.some((h) => re.test(h)))) {
      return false;
    }
    return true;
  });
}

function compile(pattern: string): RegExp {
  if (!pattern.includes('*')) {
    // Plain substring match — case-sensitive to match Postman/Newman.
    return new RegExp(escapeRegex(pattern));
  }
  // Minimal glob: escape regex specials except `*`, then expand `**` and `*`.
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*';
        i++;
      } else {
        body += '[^/]*';
      }
    } else {
      body += escapeRegex(ch);
    }
  }
  return new RegExp(`^${body}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
