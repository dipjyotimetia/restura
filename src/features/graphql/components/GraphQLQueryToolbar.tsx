import { Code2, Download, FileUp, Wand2 } from 'lucide-react';

const CHIP =
  'inline-flex items-center gap-1 h-6 px-2 rounded-sp-chip text-sp-11 font-medium text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Query tab actions: Prettify, Load schema, Code, SDL download, size. */
export function GraphQLQueryToolbar({
  queryBytes,
  canPrettify,
  canDownloadSDL,
  onPrettify,
  onLoadSchema,
  onGenerateCode,
  onDownloadSDL,
}: {
  queryBytes: number;
  canPrettify: boolean;
  canDownloadSDL: boolean;
  onPrettify: () => void;
  onLoadSchema: () => void;
  onGenerateCode: () => void;
  onDownloadSDL: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onPrettify} disabled={!canPrettify} className={CHIP}>
        <Wand2 className="h-3 w-3" />
        Prettify
      </button>
      <button
        type="button"
        onClick={onLoadSchema}
        aria-label="Load schema"
        title="Load schema from an SDL file, pasted SDL or introspection JSON"
        className={CHIP}
      >
        <FileUp className="h-3 w-3" />
        Load
      </button>
      <button
        type="button"
        onClick={onGenerateCode}
        aria-label="Generate code"
        title="Export this operation as cURL / JavaScript / Python"
        className={CHIP}
      >
        <Code2 className="h-3 w-3" />
        Code
      </button>
      <button type="button" onClick={onDownloadSDL} disabled={!canDownloadSDL} className={CHIP}>
        <Download className="h-3 w-3" />
        SDL
      </button>
      <span className="font-mono text-sp-10 text-sp-dim tabular-nums">{queryBytes} B</span>
    </div>
  );
}
