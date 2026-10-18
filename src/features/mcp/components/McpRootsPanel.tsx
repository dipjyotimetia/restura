import { ChevronDown, ChevronRight, FolderTree, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Floater, TextField } from '@/components/ui/spatial';
import { isValidRootUri } from '@/features/mcp/lib/mcpClientRequests';
import type { McpRoot } from '@/features/mcp/store/useMcpStore';

interface McpRootsPanelProps {
  roots: McpRoot[];
  /** Commit the edited list (persist + push to main, which notifies the live session). */
  onSave: (roots: McpRoot[]) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const MAX_ROOTS = 100;

/**
 * Per-connection client roots (#860, desktop-only). Edits are drafted locally
 * and committed with Save so one edit sends one
 * `notifications/roots/list_changed`, not one per keystroke.
 */
export function McpRootsPanel({ roots, onSave }: McpRootsPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<McpRoot[]>(roots);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(roots), [roots]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(roots);
  const invalid = draft.findIndex((root) => !isValidRootUri(root.uri));

  const update = (index: number, patch: Partial<McpRoot>) =>
    setDraft((current) =>
      current.map((root, i) => {
        if (i !== index) return root;
        const next = { ...root, ...patch };
        if (!next.name) delete next.name;
        return next;
      })
    );

  const save = async () => {
    if (invalid !== -1) {
      setError('Every root must be a file:// URI.');
      return;
    }
    setSaving(true);
    const result = await onSave(draft);
    setSaving(false);
    setError(result.ok ? null : result.error);
  };

  return (
    <div className="px-3 pb-2 shrink-0">
      <Floater
        radius="panel"
        elevation="float"
        className="bg-sp-surface border border-sp-line overflow-hidden"
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center justify-between px-3 h-9 hover:bg-sp-hover"
          aria-expanded={open}
        >
          <span className="sp-label inline-flex items-center gap-1.5">
            <FolderTree className="h-3.5 w-3.5" />
            Roots
            {roots.length > 0 && (
              <span className="ml-1 font-mono normal-case text-sp-dim">({roots.length})</span>
            )}
          </span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-sp-dim" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-sp-dim" />
          )}
        </button>
        {open && (
          <div className="px-3 py-2 border-t border-sp-line space-y-2">
            <p className="text-sp-11-5 text-sp-muted">
              Directories the server may operate on, answered to <code>roots/list</code>. Saving
              notifies a connected server with <code>notifications/roots/list_changed</code>.
            </p>
            {draft.map((root, index) => (
              <div key={index} className="flex items-center gap-2">
                <TextField
                  mono
                  size="sm"
                  aria-label={`Root ${index + 1} URI`}
                  aria-invalid={!isValidRootUri(root.uri)}
                  placeholder="file:///path/to/project"
                  value={root.uri}
                  onChange={(event) => update(index, { uri: event.target.value })}
                  className="flex-[2] min-w-0"
                />
                <TextField
                  size="sm"
                  aria-label={`Root ${index + 1} name`}
                  placeholder="name (optional)"
                  value={root.name ?? ''}
                  onChange={(event) => update(index, { name: event.target.value })}
                  className="flex-1 min-w-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove root ${index + 1}`}
                  onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {error && (
              <p className="text-sp-12 text-rose-400" role="alert">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={draft.length >= MAX_ROOTS}
                onClick={() => setDraft((current) => [...current, { uri: 'file:///' }])}
              >
                <Plus />
                Add root
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                Save roots
              </Button>
            </div>
          </div>
        )}
      </Floater>
    </div>
  );
}
