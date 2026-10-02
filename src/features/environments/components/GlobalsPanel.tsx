import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { useGlobalsStore } from '@/store/useGlobalsStore';

interface Row {
  id: string;
  key: string;
  value: string;
}

/** The map a draft writes: blank keys skipped, the last duplicate wins. */
export function rowsToVars(rows: readonly Row[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) vars[key] = row.value;
  }
  return vars;
}

/** Rebuild rows from the store, reusing ids by key so rows don't remount. */
export function varsToRows(vars: Record<string, string>, previous: readonly Row[]): Row[] {
  const idByKey = new Map(previous.map((r) => [r.key.trim(), r.id]));
  return Object.entries(vars).map(([key, value]) => ({
    id: idByKey.get(key) ?? uuidv4(),
    key,
    value,
  }));
}

const sameVars = (a: Record<string, string>, b: Record<string, string>) => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => b[k] === a[k]);
};

const inputClass =
  'h-7 w-full min-w-0 rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2 font-mono text-sp-12 text-sp-text placeholder:text-sp-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent';

/**
 * Workspace globals (`pm.globals`) — resolved after the active environment,
 * shared by every request and protocol. Values are stored as plain text, like
 * other workspace data; use environment secrets for credentials.
 */
export function GlobalsPanel() {
  const vars = useGlobalsStore((s) => s.vars);
  const replace = useGlobalsStore((s) => s.replace);
  const [rows, setRows] = useState<Row[]>(() => varsToRows(vars, []));
  // The map this editor last wrote; anything else came from outside (scripts).
  const written = useRef(vars);

  useEffect(() => {
    if (!sameVars(vars, written.current)) {
      written.current = vars;
      setRows((prev) => varsToRows(vars, prev));
    }
  }, [vars]);

  const commit = (next: Row[]) => {
    setRows(next);
    const map = rowsToVars(next);
    written.current = map;
    replace(map);
  };

  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
    return dup;
  }, [rows]);

  const update = (id: string, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <section>
        <div className="sp-label mb-1">Globals</div>
        <p className="mb-3 text-sp-12 text-sp-muted">
          Available to every request as <code className="font-mono">{'{{name}}'}</code>, after the
          active environment. Scripts read and write them with{' '}
          <code className="font-mono">pm.globals</code>. Stored as plain values — keep credentials
          in environment secrets.
        </p>
        <Floater radius="panel" elevation="inset" className="p-3 space-y-1.5">
          {rows.length === 0 && (
            <p className="py-4 text-center font-mono text-sp-12 text-sp-dim">No globals yet</p>
          )}
          {rows.map((row) => {
            const dup = duplicates.has(row.key.trim());
            return (
              <div key={row.id} className="flex items-center gap-2">
                <input
                  value={row.key}
                  onChange={(e) => update(row.id, { key: e.target.value })}
                  placeholder="name"
                  aria-label="Global name"
                  aria-invalid={dup || undefined}
                  className={cn(inputClass, dup && 'border-[var(--color-warning)]')}
                />
                <input
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  placeholder="value"
                  aria-label={`Value of ${row.key || 'global'}`}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => commit(rows.filter((r) => r.id !== row.id))}
                  aria-label={`Remove ${row.key || 'global'}`}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sp-btn text-sp-dim hover:bg-sp-hover hover:text-sp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {duplicates.size > 0 && (
            <p role="alert" className="text-sp-11 text-[var(--color-warning)]">
              Duplicate names: {[...duplicates].join(', ')} — the last one wins.
            </p>
          )}
          <button
            type="button"
            onClick={() => setRows([...rows, { id: uuidv4(), key: '', value: '' }])}
            className="inline-flex items-center gap-1 rounded-sp-chip pt-1 text-sp-12 text-sp-dim hover:text-sp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <Plus className="h-3 w-3" />
            Add global
          </button>
        </Floater>
      </section>
    </div>
  );
}
