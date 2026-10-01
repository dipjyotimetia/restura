import { ChevronRight, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type JsonPathSegment, jsonPathFor, previewJson } from '@/lib/shared/jsonTreePath';
import { cn } from '@/lib/shared/utils';

/** Children shown per container before a "show more" button. */
const PAGE = 100;
/** Containers deeper than this start collapsed. */
const OPEN_DEPTH = 2;

/** Collapsible JSON viewer with copy-path / copy-value on every node. */
export default function JsonTree({ value }: { value: unknown }) {
  return (
    <div
      role="tree"
      aria-label="JSON response"
      className="h-full overflow-auto p-3 font-mono text-sp-12"
    >
      <JsonNode name={null} value={value} path={[]} depth={0} />
    </div>
  );
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] =>
  v !== null && typeof v === 'object';

function valueClass(v: unknown): string {
  if (typeof v === 'string') return 'text-[var(--color-success)]';
  if (typeof v === 'number') return 'text-sp-accent';
  if (typeof v === 'boolean' || v === null) return 'text-[var(--color-warning)]';
  return 'text-sp-dim';
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}`);
  }
}

function JsonNode({
  name,
  value,
  path,
  depth,
}: {
  name: JsonPathSegment | null;
  value: unknown;
  path: JsonPathSegment[];
  depth: number;
}) {
  const container = isContainer(value);
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [shown, setShown] = useState(PAGE);
  const entries: Array<[JsonPathSegment, unknown]> = container
    ? Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value)
    : [];

  const label =
    name === null ? null : (
      <span className="text-sp-muted">
        {typeof name === 'number' ? name : JSON.stringify(name)}:{' '}
      </span>
    );

  return (
    <div role="treeitem" aria-level={depth + 1} aria-expanded={container ? open : undefined}>
      <div className="group flex items-center gap-1 rounded-sp-btn px-1 hover:bg-sp-hover">
        {container ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sp-chip text-sp-dim hover:text-sp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {label}
          <span className={valueClass(value)}>
            {container && open ? (Array.isArray(value) ? '[' : '{') : previewJson(value)}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={() => void copy(jsonPathFor(path), 'Path')}
            className="rounded-sp-chip px-1 text-sp-11 text-sp-dim hover:text-sp-text hover:bg-sp-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            Copy path
          </button>
          <button
            type="button"
            onClick={() =>
              void copy(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'Value')
            }
            aria-label="Copy value"
            className="inline-flex items-center rounded-sp-chip px-1 text-sp-dim hover:text-sp-text hover:bg-sp-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <Copy className="h-3 w-3" />
          </button>
        </span>
      </div>
      {container && open && (
        <div role="group" className="ml-3 border-l border-sp-line pl-2">
          {entries.slice(0, shown).map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} path={[...path, key]} depth={depth + 1} />
          ))}
          {entries.length > shown && (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className="ml-5 my-0.5 rounded-sp-btn px-1 text-sp-11 text-sp-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
            >
              Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
            </button>
          )}
          <span className="text-sp-dim">{Array.isArray(value) ? ']' : '}'}</span>
        </div>
      )}
    </div>
  );
}
