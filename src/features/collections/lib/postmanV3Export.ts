import {
  exportPostmanV3,
  type PostmanExportReport,
  postmanV3SafeFileName,
} from '@shared/collections/postman';
import { toast } from 'sonner';
import { showPostmanExportReport } from '@/components/shared/PostmanExportReport';
import { downloadBlob } from '@/lib/shared/file-utils';
import { getElectronAPI } from '@/lib/shared/platform';
import type { Collection } from '@/types';

/**
 * Postman v3 (#1201): the YAML folder as `{ relativePath, content }` entries
 * under one `<name>/` root (zip root on the web, written folder on desktop),
 * plus the export report. Callers apply the "include secrets" redaction first.
 */
export function exportToPostmanV3(collection: Collection): {
  root: string;
  entries: Array<{ relativePath: string; content: string }>;
  report: PostmanExportReport;
} {
  const { files, report } = exportPostmanV3(collection);
  const root = postmanV3SafeFileName(collection.name);
  const entries = Object.entries(files).map(([path, content]) => ({
    relativePath: `${root}/${path}`,
    content,
  }));
  return { root, entries, report };
}

/**
 * Save a Postman v3 export: a folder on desktop (picked directory, written by
 * the existing validated directory-export IPC under `<picked>/<name>/`), a
 * `<name>.postman-v3.zip` download on the web; then show the export report.
 * Returns false when cancelled or failed. `collection` is already redacted
 * per the include-secrets choice.
 */
export async function savePostmanV3Export(collection: Collection): Promise<boolean> {
  const { root, entries, report } = exportToPostmanV3(collection);
  const api = getElectronAPI();
  if (api?.collections) {
    const directory = await api.collections.selectDirectory();
    const target = directory.filePaths?.[0];
    if (directory.canceled || !target) return false;
    const saved = await api.collections.saveBrunoToDirectory(entries, target);
    if (!saved.success) {
      toast.error(saved.error ?? 'Postman v3 export failed');
      return false;
    }
    showPostmanExportReport(report, `Exported Postman v3 folder "${root}"`);
    return true;
  }
  const { zipEntries } = await import('@/lib/shared/zip-utils');
  downloadBlob(await zipEntries(entries), `${root}.postman-v3.zip`, 'application/zip');
  showPostmanExportReport(report, `Exported ${root}.postman-v3.zip`);
  return true;
}
