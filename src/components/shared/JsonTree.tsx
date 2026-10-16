import { AlertCircle, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type JsonPathSegment, jsonPathFor, previewJson } from '@/lib/shared/jsonTreePath';
import { cn } from '@/lib/shared/utils';

/** Children shown per container before a "show more" button. */
const PAGE = 100;
/** Containers deeper than this start collapsed. */
const OPEN_DEPTH = 2;

/** A node to flag (e.g. a GraphQL error `path`), with a reason shown on hover. */
export interface JsonTreeHighlight {
  path: readonly JsonPathSegment[];
  label: string;
}

/** Scroll to + reveal `path`; bump `nonce` to re-trigger for the same path. */
export interface JsonTreeFocus {
  path: readonly JsonPathSegment[];
  nonce: number;
}

interface TreeMarks {
  /** pathKey -> reasons */
  highlighted: Map<string, string[]>;
  /** Ancestors of highlighted nodes start expanded so the flag is visible. */
  highlightAncestors: Set<string>;
  focus: JsonTreeFocus | undefined;
  focusKey: string | undefined;
}

const pathKey = (path: readonly JsonPathSegment[]): string => JSON.stringify(path);

const EMPTY_MARKS: TreeMarks = {
  highlighted: new Map(),
  highlightAncestors: new Set(),
  focus: undefined,
  focusKey: undefined,
};

/** Collapsible JSON viewer with copy-path / copy-value on every node. */
export default function JsonTree({
  value,
  highlights,
  focus,
}: {
  value: unknown;
  highlights?: readonly JsonTreeHighlight[];
  focus?: JsonTreeFocus;
}) {
  const marks = useMemo<TreeMarks>(() => {
    if (!highlights?.length && !focus) return EMPTY_MARKS;
    const highlighted = new Map<string, string[]>();
    const highlightAncestors = new Set<string>();
    for (const h of highlights ?? []) {
      const key = pathKey(h.path);
      highlighted.set(key, [...(highlighted.get(key) ?? []), h.label]);
      for (let i = 0; i < h.path.length; i++) highlightAncestors.add(pathKey(h.path.slice(0, i)));
    }
    return {
      highlighted,
      highlightAncestors,
      focus,
      focusKey: focus ? pathKey(focus.path) : undefined,
    };
  }, [highlights, focus]);

  return (
    <div
      role="tree"
      aria-label="JSON response"
      className="h-full overflow-auto p-3 font-mono text-sp-12"
    >
      <JsonNode name={null} value={value} path={[]} depth={0} marks={marks} />
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
  marks,
}: {
  name: JsonPathSegment | null;
  value: unknown;
  path: JsonPathSegment[];
  depth: number;
  marks: TreeMarks;
}) {
  const container = isContainer(value);
  const key = pathKey(path);
  const [open, setOpen] = useState(depth < OPEN_DEPTH || marks.highlightAncestors.has(key));
  const [shown, setShown] = useState(PAGE);
  const rowRef = useRef<HTMLDivElement>(null);
  const entries: Array<[JsonPathSegment, unknown]> = container
    ? Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value)
    : [];
  const reasons = marks.highlighted.get(key);
  const isFocused = marks.focusKey === key;

  // Jump-to: every ancestor on the focus path expands (and pages far enough
  // to render the next step); the target itself scrolls into view.
  const { focus } = marks;
  // Keyed on the nonce only: re-runs per focus request, not per render.
  useEffect(() => {
    if (!focus) return;
    if (isFocused) {
      rowRef.current?.scrollIntoView?.({ block: 'center' });
      rowRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!container || focus.path.length <= path.length) return;
    if (pathKey(focus.path.slice(0, path.length)) !== key) return;
    const next = focus.path[path.length];
    const index = entries.findIndex(([k]) => k === next);
    if (index < 0) return;
    setOpen(true);
    setShown((s) => Math.max(s, index + 1));
  }, [focus?.nonce]);

  const label =
    name === null ? null : (
      <span className="text-sp-muted">
        {typeof name === 'number' ? name : JSON.stringify(name)}:{' '}
      </span>
    );

  return (
    <div role="treeitem" aria-level={depth + 1} aria-expanded={container ? open : undefined}>
      <div
        ref={rowRef}
        tabIndex={isFocused ? -1 : undefined}
        data-highlighted={reasons ? 'true' : undefined}
        className={cn(
          'group flex items-center gap-1 rounded-sp-btn px-1 hover:bg-sp-hover focus:outline-none',
          reasons && 'bg-destructive/10',
          isFocused && 'ring-1 ring-destructive/60'
        )}
      >
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
        {reasons && (
          <span
            role="img"
            title={reasons.join('\n')}
            aria-label={`Error: ${reasons.join('; ')}`}
            className="inline-flex shrink-0 text-destructive"
          >
            <AlertCircle className="h-3 w-3" />
          </span>
        )}
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
          {entries.slice(0, shown).map(([childKey, child]) => (
            <JsonNode
              key={childKey}
              name={childKey}
              value={child}
              path={[...path, childKey]}
              depth={depth + 1}
              marks={marks}
            />
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
