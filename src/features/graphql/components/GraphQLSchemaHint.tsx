/**
 * One-line hint above the query editor when no schema is available, so it's
 * obvious why autocomplete/validation are off and how to fix it.
 */
export function GraphQLSchemaHint({
  failed,
  canIntrospect,
  onShowDetails,
  onIntrospect,
  onLoadFile,
}: {
  /** The last introspection failed (vs. never ran). */
  failed: boolean;
  canIntrospect: boolean;
  onShowDetails: () => void;
  onIntrospect: () => void;
  onLoadFile: () => void;
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 h-7 border-b border-sp-line text-sp-11 text-sp-muted"
    >
      <span className="truncate">
        {failed ? 'Introspection failed — autocomplete off' : 'No schema — autocomplete off'}
      </span>
      {failed && (
        <button type="button" onClick={onShowDetails} className="underline hover:text-sp-text">
          Details
        </button>
      )}
      <button
        type="button"
        onClick={onIntrospect}
        disabled={!canIntrospect}
        aria-label="Introspect schema"
        className="ml-auto underline hover:text-sp-text disabled:opacity-50 disabled:no-underline"
      >
        Introspect
      </button>
      <button
        type="button"
        onClick={onLoadFile}
        aria-label="Load schema file"
        className="underline hover:text-sp-text"
      >
        Load file
      </button>
    </div>
  );
}
