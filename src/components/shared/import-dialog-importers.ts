import {
  type ImportResult,
  type ImportWarning,
  importBrunoCollection,
  importCurlCommand,
  importHoppscotchCollection,
  importHttpFile,
  importInsomniaCollection,
  importOpenAPICollection,
  importOpenCollection,
} from '@/features/collections/lib/importers';
import { importPostmanWithReport } from '@/features/collections/lib/importers/postman';
import type { ParsedImportType } from './import-dialog-data';

/** Collection importer per detected format; `sourceUrl` is where a remote source came from. */
export const IMPORTERS: Record<
  ParsedImportType,
  (data: unknown, sourceUrl?: string) => Promise<ImportResult>
> = {
  // v2.x JSON or a single-file v3 logical tree (`$kind: collection`).
  postman: async (data) => importPostmanWithReport(data),
  insomnia: async (data) => importInsomniaCollection(data),
  openapi: async (data, sourceUrl) => {
    const warnings: ImportWarning[] = [];
    // A spec fetched from a URL resolves a relative `servers` entry against it.
    const collection = await importOpenAPICollection(
      data,
      warnings,
      sourceUrl ? { sourceUrl } : {}
    );
    return { collection, warnings };
  },
  opencollection: async (data) => importOpenCollection(data),
  hoppscotch: async (data) => importHoppscotchCollection(data),
  bruno: async (data) =>
    importBrunoCollection({
      kind: 'single',
      content: String(data),
    }),
  http: async (data) => importHttpFile(String(data)),
  curl: async (data) => importCurlCommand(String(data)),
};
