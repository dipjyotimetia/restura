import {
  exportPostmanV3,
  type PostmanExportReport,
  postmanV3SafeFileName,
} from '@shared/collections/postman';
import { toast } from 'sonner';
import {
  PostmanExportReportList,
  showPostmanExportReport,
} from '@/components/shared/PostmanExportReport';
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

export interface SavePostmanV3Options {
  /** Asked when `<picked>/<name>/` already exists and is non-empty (default: native confirm). */
  confirmReplace?: (folderName: string, directory: string) => Promise<boolean>;
}

const nativeConfirm = async (folderName: string, directory: string) =>
  window.confirm(
    `A folder "${folderName}" already exists in ${directory} and is not empty.\n\nReplace its Postman request, example and definition files with this export? Other files are left untouched.`
  );

/** Failure toast that still surfaces what the export would have left out. */
function failed(reason: string, report: PostmanExportReport): false {
  toast.error(
    `Postman v3 export failed: ${reason}`,
    report.entries.length > 0 ? { description: <PostmanExportReportList report={report} /> } : {}
  );
  return false;
}

/**
 * Save a Postman v3 export: a folder on desktop (picked directory, written by
 * the validated directory-export IPC under `<picked>/<name>/`; an existing
 * non-empty folder is only replaced after confirmation), a
 * `<name>.postman-v3.zip` download on the web; then show the export report.
 * Returns false when cancelled or failed (every failure is a visible error).
 * `collection` is already redacted per the include-secrets choice.
 */
export async function savePostmanV3Export(
  collection: Collection,
  options: SavePostmanV3Options = {}
): Promise<boolean> {
  const { root, entries, report } = exportToPostmanV3(collection);
  const api = getElectronAPI();
  try {
    if (api?.collections) {
      const directory = await api.collections.selectDirectory();
      const target = directory.filePaths?.[0];
      if (directory.canceled || !target) return false;
      const existing = await api.collections.inspectExportTarget(target, root);
      let replace = false;
      if (existing.nonEmpty) {
        replace = await (options.confirmReplace ?? nativeConfirm)(root, target);
        if (!replace) return false;
      }
      const saved = replace
        ? await api.collections.saveBrunoToDirectory(entries, target, {
            replace: { layout: 'postman-v3', subdir: root },
          })
        : await api.collections.saveBrunoToDirectory(entries, target);
      if (!saved.success) return failed(saved.error ?? 'the folder could not be written', report);
      showPostmanExportReport(report, `Exported Postman v3 folder "${root}"`);
      return true;
    }
    const { zipEntries } = await import('@/lib/shared/zip-utils');
    downloadBlob(await zipEntries(entries), `${root}.postman-v3.zip`, 'application/zip');
    showPostmanExportReport(report, `Exported ${root}.postman-v3.zip`);
    return true;
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), report);
  }
}
