/**
 * Ambient type declarations for `@usebruno/lang` (which ships pure JS).
 *
 * The exported functions parse Bruno's `.bru` DSL into a JS object. The
 * actual shape varies per block (meta, http, headers, body:*, auth:*, etc.)
 * — see `src/features/collections/lib/importers/bruno.ts` for the verified
 * shapes we depend on. Returning `unknown` here forces the importer to do
 * its own narrowing (which it already does).
 */
declare module '@usebruno/lang' {
  export const bruToJsonV2: (raw: string) => unknown;
  export const bruToEnvJsonV2: (raw: string) => unknown;
  export const collectionBruToJson: (raw: string) => unknown;
  export const jsonToBruV2: (json: unknown) => string;
  export const envJsonToBruV2: (json: unknown) => string;
  export const jsonToCollectionBru: (json: unknown) => string;
  export const dotenvToJson: (raw: string) => unknown;
}
