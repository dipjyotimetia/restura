/**
 * Shared lazy loader for @usebruno/lang.
 *
 * The grammar bundle is ~400KB. Loading it on demand keeps it out of the
 * main bundle for users who never touch Bruno collections. Both the
 * importer and exporter share this loader so the dynamic-import statement
 * (and the resulting code-split chunk) is unique.
 */

export interface BrunoLangModule {
  // Import side
  bruToJsonV2: (raw: string) => unknown;
  bruToEnvJsonV2: (raw: string) => unknown;
  collectionBruToJson: (raw: string) => unknown;
  // Export side
  jsonToBruV2: (json: unknown) => string;
  envJsonToBruV2: (json: unknown) => string;
  jsonToCollectionBru: (json: unknown) => string;
}

const REQUIRED_FNS: Array<keyof BrunoLangModule> = [
  'bruToJsonV2',
  'bruToEnvJsonV2',
  'collectionBruToJson',
  'jsonToBruV2',
  'envJsonToBruV2',
  'jsonToCollectionBru',
];

let cached: BrunoLangModule | null = null;

export async function loadBrunoLang(): Promise<BrunoLangModule> {
  if (cached) return cached;
  const mod = (await import('@usebruno/lang')) as unknown as {
    default?: BrunoLangModule;
  } & BrunoLangModule;
  const lang: BrunoLangModule = mod.default ?? mod;
  for (const fn of REQUIRED_FNS) {
    if (typeof lang[fn] !== 'function') {
      throw new Error(`@usebruno/lang missing expected export "${fn}"`);
    }
  }
  cached = lang;
  return lang;
}
