import { describeWarning } from '@/components/shared/ImportStatusBanner';
import type { ImportResult, ImportWarning } from '@/features/collections/lib/importers';
import { countFolders, countRequests } from '../lib/countRequests';
import { uniqueName } from '../lib/names';

const REVIEW_WARNING_PREVIEW = 5;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** "12 requests in 3 folders" — the whole tree, not just the top level. */
function describeImportSize(items: Parameters<typeof countRequests>[0]): string {
  const requests = plural(countRequests(items), 'request');
  const folders = countFolders(items);
  return folders > 0 ? `${requests} in ${plural(folders, 'folder')}` : requests;
}

export type NameClashChoice = 'keep-both' | 'replace';

interface ImportPendingReviewProps {
  outcome:
    | ImportResult
    | { kind: 'environment-only'; environment: { name: string }; droppedSecretKeys: string[] };
  /** Detected-format label, when the format was auto-detected. */
  formatName: string | undefined;
  warnings: readonly ImportWarning[];
  /** Names of the collections already in the workspace (for the name-clash choice). */
  existingNames: readonly string[];
  clashChoice: NameClashChoice;
  onClashChoiceChange: (choice: NameClashChoice) => void;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The "Review before importing" card: what will be imported (whole-tree
 * counts), the warnings it carries, and — on a name clash — whether to keep
 * both (auto-suffixed) or replace the existing collection.
 */
export function ImportPendingReview({
  outcome,
  formatName,
  warnings,
  existingNames,
  clashChoice,
  onClashChoiceChange,
  confirming,
  onConfirm,
  onCancel,
}: ImportPendingReviewProps) {
  return (
    <section
      className="rounded-sp-btn border border-sp-accent/50 bg-sp-active p-4"
      aria-label="Import preview"
    >
      <div className="sp-label">Review before importing</div>
      {formatName && <p className="mt-1 text-sp-12 text-sp-muted">Detected format: {formatName}</p>}
      {'kind' in outcome ? (
        <>
          <p className="mt-1 text-sp-12 text-sp-text">
            Environment: <strong>{outcome.environment.name}</strong>
          </p>
          {outcome.droppedSecretKeys.length > 0 && (
            <p className="mt-1 text-sp-12 text-amber-300">
              Secret values are not imported in the browser. Re-enter after import:{' '}
              {outcome.droppedSecretKeys.join(', ')}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-sp-12 text-sp-text">
            Collection: <strong>{outcome.collection.name}</strong> ·{' '}
            {describeImportSize(outcome.collection.items)}
          </p>
          {existingNames.includes(outcome.collection.name) && (
            <fieldset className="mt-2 rounded-sp-btn border border-amber-500/40 p-2 text-sp-12">
              <legend className="px-1 text-amber-300">
                A collection named "{outcome.collection.name}" already exists
              </legend>
              <label className="flex items-center gap-2 text-sp-text">
                <input
                  type="radio"
                  name="import-name-clash"
                  checked={clashChoice === 'keep-both'}
                  onChange={() => onClashChoiceChange('keep-both')}
                />
                Keep both (import as "{uniqueName(outcome.collection.name, [...existingNames])}")
              </label>
              <label className="mt-1 flex items-center gap-2 text-sp-text">
                <input
                  type="radio"
                  name="import-name-clash"
                  checked={clashChoice === 'replace'}
                  onChange={() => onClashChoiceChange('replace')}
                />
                Replace the existing collection (its linked workflows are removed)
              </label>
            </fieldset>
          )}
          <p className="mt-1 text-sp-12 text-sp-muted">
            Imported scripts and requests are stored only; nothing is executed during import.
          </p>
        </>
      )}
      {warnings.length > 0 && (
        <div className="mt-2 text-sp-12 text-sp-muted">
          <p>
            {warnings.length} warning{warnings.length === 1 ? '' : 's'} will be retained in the
            import review.
          </p>
          <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5 pr-1">
            {warnings.slice(0, REVIEW_WARNING_PREVIEW).map((warning, index) => (
              <li key={index} className="flex gap-2">
                <span className="text-amber-400/70 shrink-0">›</span>
                <span>{describeWarning(warning)}</span>
              </li>
            ))}
            {warnings.length > REVIEW_WARNING_PREVIEW && (
              <li className="italic">
                … and {warnings.length - REVIEW_WARNING_PREVIEW} more, listed after import
              </li>
            )}
          </ul>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="rounded-sp-btn bg-sp-accent px-3 py-2 text-sp-12 font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent disabled:opacity-60"
        >
          Confirm import
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sp-btn border border-sp-line px-3 py-2 text-sp-12 text-sp-text"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
