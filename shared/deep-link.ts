import { validateURL } from './protocol/url-validation';

export const DEEP_LINK_IMPORT_FORMATS = [
  'postman',
  'insomnia',
  'openapi',
  'opencollection',
  'hoppscotch',
  'bruno',
  'http',
] as const;
export type DeepLinkImportFormat = (typeof DEEP_LINK_IMPORT_FORMATS)[number];
export const DEEP_LINK_SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'requests',
  'proxy',
  'certificates',
  'security',
  'secrets',
  'ai',
  'data',
  'updates',
  'shortcuts',
  'about',
] as const;
export type DeepLinkSettingsSection = (typeof DEEP_LINK_SETTINGS_SECTIONS)[number];
export type DeepLinkAction =
  | { kind: 'import'; url: string; format?: DeepLinkImportFormat }
  | { kind: 'environment'; id: string }
  | { kind: 'collection'; id: string }
  | { kind: 'request'; id: string }
  | { kind: 'settings'; section: DeepLinkSettingsSection };
export type DeepLinkPayload = DeepLinkAction & { id: string };

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? (values[0] ?? null) : null;
}
function only(params: URLSearchParams, allowed: readonly string[]): boolean {
  return [...params.keys()].every((key) => allowed.includes(key));
}
function validId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Parse the public deep-link contract before it crosses into renderer state. */
export function parseDeepLink(url: string): DeepLinkAction | null {
  if (url.length === 0 || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'restura:' || parsed.username || parsed.password || parsed.hash)
      return null;
    switch (parsed.hostname) {
      case 'import': {
        if (!only(parsed.searchParams, ['url', 'format'])) return null;
        const source = single(parsed.searchParams, 'url');
        const format = single(parsed.searchParams, 'format');
        if (
          !source ||
          (format !== null && !DEEP_LINK_IMPORT_FORMATS.includes(format as DeepLinkImportFormat))
        )
          return null;
        const valid = validateURL(source, {
          allowedSchemes: ['http:', 'https:'],
          allowPrivateIPs: false,
          allowLocalhost: false,
        });
        if (!valid.valid) return null;
        const sourceUrl = new URL(source);
        if (sourceUrl.username || sourceUrl.password) return null;
        return {
          kind: 'import',
          url: source,
          ...(format ? { format: format as DeepLinkImportFormat } : {}),
        };
      }
      case 'environment':
      case 'collection':
      case 'request': {
        if (!only(parsed.searchParams, ['id'])) return null;
        const id = single(parsed.searchParams, 'id');
        return validId(id) ? { kind: parsed.hostname, id } : null;
      }
      case 'settings': {
        if (!only(parsed.searchParams, ['section'])) return null;
        const section = single(parsed.searchParams, 'section');
        return section !== null &&
          DEEP_LINK_SETTINGS_SECTIONS.includes(section as DeepLinkSettingsSection)
          ? { kind: 'settings', section: section as DeepLinkSettingsSection }
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
