import { Checkbox } from '@/components/ui/checkbox';
import { Floater } from '@/components/ui/spatial';
import type { HarImportPreview } from '@/features/collections/lib/importers';

interface HarImportReviewProps {
  preview: HarImportPreview;
  selectedEntries: ReadonlySet<string>;
  selectedEnvironments: ReadonlySet<string>;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onToggleEntry: (entryId: string) => void;
  onToggleEnvironment: (candidateId: string) => void;
  onChooseAnotherFile: () => void;
  onConfirm: () => void;
}

/** Review-only HAR UI. It receives sanitized data and cannot persist it itself. */
export function HarImportReview({
  preview,
  selectedEntries,
  selectedEnvironments,
  onSelectAll,
  onSelectNone,
  onToggleEntry,
  onToggleEnvironment,
  onChooseAnotherFile,
  onConfirm,
}: HarImportReviewProps) {
  return (
    <section className="space-y-4" aria-label="HAR review">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sp-15 font-semibold text-sp-text">Review HAR import</h2>
          <p className="mt-1 text-sp-12 text-sp-muted">
            Requests are redacted and remain unpersisted until you confirm this import.
          </p>
        </div>
        <button
          type="button"
          onClick={onChooseAnotherFile}
          className="text-sp-12 text-sp-muted underline underline-offset-2 hover:text-sp-text"
        >
          Choose another file
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="rounded-sp-btn border border-sp-line px-3 py-1.5 text-sp-12 text-sp-text hover:bg-sp-hover"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          className="rounded-sp-btn border border-sp-line px-3 py-1.5 text-sp-12 text-sp-text hover:bg-sp-hover"
        >
          Select none
        </button>
      </div>
      {preview.warnings.length > 0 && (
        <div className="rounded-sp-btn border border-amber-500/30 bg-amber-500/10 p-3 text-sp-12 text-amber-200">
          {preview.warnings.length} conversion warning
          {preview.warnings.length === 1 ? '' : 's'} will be retained with the import.
        </div>
      )}
      {preview.environmentCandidates.length > 0 && (
        <Floater radius="panel" elevation="inset" className="p-3 space-y-2">
          <p className="text-sp-12 text-sp-muted">
            Optional environments are not created unless selected.
          </p>
          {preview.environmentCandidates.map((candidate) => (
            <label key={candidate.id} className="flex items-center gap-2 text-sp-12 text-sp-text">
              <Checkbox
                checked={selectedEnvironments.has(candidate.id)}
                onCheckedChange={() => onToggleEnvironment(candidate.id)}
                aria-label={`Create ${candidate.name}`}
              />
              Create {candidate.name} with <code>baseUrl={candidate.baseUrl}</code>
            </label>
          ))}
        </Floater>
      )}
      {preview.groups.map((group) => (
        <Floater key={group.id} radius="panel" elevation="inset" className="p-3 space-y-2">
          <h3 className="text-sp-13 font-medium text-sp-text">{group.name}</h3>
          {group.entries.map((entry) => (
            <label
              key={entry.id}
              className="flex items-start gap-2 rounded-sp-btn p-2 hover:bg-sp-hover"
            >
              <Checkbox
                checked={selectedEntries.has(entry.id)}
                onCheckedChange={() => onToggleEntry(entry.id)}
                aria-label={`Select ${entry.name}`}
              />
              <span className="min-w-0 text-sp-12 text-sp-text">
                <span className="font-mono font-medium">{entry.name}</span>
                <span className="ml-2 break-all text-sp-muted">{entry.url}</span>
                {entry.stateChanging && <span className="ml-2 text-amber-300">State-changing</span>}
              </span>
            </label>
          ))}
        </Floater>
      ))}
      <button
        type="button"
        onClick={onConfirm}
        disabled={selectedEntries.size === 0}
        className="rounded-sp-btn bg-sp-accent px-4 py-2 text-sp-12 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        Import selected requests
      </button>
    </section>
  );
}
