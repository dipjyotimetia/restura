import type { ParsedMcpEntry } from '@shared/mcp-import/mcp-config-parser';
import type {
  McpImportDraft,
  McpImportPreviewEntry,
  McpImportPreviewSource,
} from '@shared/mcp-import/mcp-import-model';
import { FileUp, Import, KeyRound, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  addDraftsAsCollection,
  MCP_IMPORT_COLLECTION_NAME,
  scanPastedConfig,
  webDraftsFor,
} from '@/features/mcp/lib/mcpImport';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';

type ElectronAPI = NonNullable<ReturnType<typeof getElectronAPI>>;

const MAX_UPLOAD_BYTES = 1024 * 1024;

type Scan =
  | { kind: 'desktop'; sources: McpImportPreviewSource[]; sessionId: string }
  | { kind: 'web'; sources: McpImportPreviewSource[]; entries: Map<string, ParsedMcpEntry> };

function selectable(entry: McpImportPreviewEntry, desktop: boolean): boolean {
  if (entry.kind === 'invalid') return false;
  return entry.kind === 'http' || desktop;
}

function describeEntry(entry: McpImportPreviewEntry): string {
  if (entry.kind === 'http') return `${entry.transport ?? 'http'} · ${entry.url ?? ''}`;
  if (entry.kind === 'stdio') return [entry.command, ...(entry.args ?? [])].join(' ');
  return entry.reason ?? 'Unsupported entry';
}

function EntryRow({
  entry,
  desktop,
  checked,
  onToggle,
}: {
  entry: McpImportPreviewEntry;
  desktop: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const canSelect = selectable(entry, desktop);
  const secretNames = [...(entry.env ?? []), ...(entry.headers ?? [])]
    .filter((row) => row.secret)
    .map((row) => row.name);
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Checkbox
        checked={checked}
        disabled={!canSelect}
        onCheckedChange={onToggle}
        aria-label={`Import ${entry.name}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sp-13">
          <span className="font-medium text-sp-text truncate">{entry.name}</span>
          <span className="text-sp-11 text-sp-dim">{entry.kind}</span>
          {entry.disabled && <span className="text-sp-11 text-sp-dim">disabled in source</span>}
          {entry.kind === 'stdio' && !desktop && (
            <span className="text-sp-11 text-amber-400">desktop app only</span>
          )}
        </div>
        <div className="font-mono text-sp-12 text-sp-dim truncate">{describeEntry(entry)}</div>
        {secretNames.length > 0 && (
          <div className="flex items-center gap-1 text-sp-11 text-sp-dim">
            <KeyRound className="h-3 w-3" />
            {desktop && entry.kind === 'stdio'
              ? `Stored as protected secrets: ${secretNames.join(', ')}`
              : `Sensitive values hidden: ${secretNames.join(', ')}`}
          </div>
        )}
        {entry.warnings.map((w, i) => (
          <div key={i} className="text-sp-11 text-amber-400">
            {w}
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * Import MCP server definitions from Claude Desktop, Cursor and VS Code config
 * files (#906). Desktop reads files in the main process (well-known locations
 * or a native file picker); web accepts pasted/uploaded JSON, HTTP entries
 * only. A preview step runs before anything is created, and imported stdio
 * servers still hit the consent prompt on their first launch.
 */
export function McpImportDialog() {
  const desktop = isElectron();
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => {
    setScan(null);
    setSelected(new Set());
    setPasted('');
    setNotice(null);
  };

  const showScan = (next: Scan) => {
    setScan(next);
    const initial = new Set<string>();
    for (const source of next.sources) {
      for (const entry of source.entries) {
        if (selectable(entry, desktop) && !entry.disabled) initial.add(entry.key);
      }
    }
    setSelected(initial);
    if (next.sources.length === 0) setNotice('No MCP client configuration was found.');
  };

  const scanDesktop = async (source: 'detect' | 'pick') => {
    setBusy(true);
    setNotice(null);
    try {
      // Desktop-only buttons call this; a missing bridge surfaces as the catch notice.
      const api = (getElectronAPI() as ElectronAPI).mcp;
      const result = await api.importScan({ source });
      if (result.sources.length === 0 && source === 'pick') return; // picker cancelled
      showScan({ kind: 'desktop', sources: result.sources, sessionId: result.sessionId ?? '' });
    } catch {
      setNotice('Could not read MCP configuration.');
    } finally {
      setBusy(false);
    }
  };

  const scanWeb = (text: string, label: string) => {
    const { source, entries } = scanPastedConfig(text, label);
    showScan({ kind: 'web', sources: [source], entries });
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return; // chooser cancelled
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice('That file is larger than 1 MB and was not read.');
      return;
    }
    scanWeb(await file.text(), file.name);
  };

  const doImport = async (current: Scan) => {
    const keys = [...selected];
    setBusy(true);
    try {
      let drafts: McpImportDraft[] = [];
      let skipped: Array<{ name: string; reason: string }> = [];
      if (current.kind === 'desktop') {
        const api = (getElectronAPI() as ElectronAPI).mcp;
        const result = await api.importCommit({ sessionId: current.sessionId, keys });
        drafts = result.drafts;
        skipped = result.skipped;
      } else {
        drafts = webDraftsFor(current.entries, keys);
      }
      if (drafts.length > 0) addDraftsAsCollection(drafts);
      if (skipped.length > 0) {
        toast.warning(
          `Skipped ${skipped.length}: ${skipped.map((s) => `${s.name || 'entry'} (${s.reason})`).join('; ')}`
        );
      }
      if (drafts.length > 0) {
        toast.success(
          `Imported ${drafts.length} MCP server${drafts.length === 1 ? '' : 's'} into "${MCP_IMPORT_COLLECTION_NAME}". Local servers ask for approval before they first start.`
        );
        setOpen(false);
        reset();
      }
    } catch {
      toast.error('Import failed. Scan again and retry.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Import servers from Claude Desktop, Cursor or VS Code"
          className="h-9 px-3 text-sp-12 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line"
        >
          <Import className="h-3.5 w-3.5" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader icon={Import}>
          <DialogTitle>Import MCP servers</DialogTitle>
          <DialogDescription>
            Reads mcp.json from Claude Desktop, Cursor or VS Code. Nothing is created until you
            confirm
            {desktop
              ? ', and local servers still ask for approval before they first start.'
              : '. Only remote (HTTP) servers can be imported on the web.'}{' '}
            Values of credential-named variables and headers are hidden here; other values are
            shown. Credentials in arguments and URLs are masked in this preview only and are
            imported exactly as written.
          </DialogDescription>
        </DialogHeader>

        {!scan && desktop && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => scanDesktop('detect')} disabled={busy} variant="secondary">
              <Search className="h-3.5 w-3.5" />
              Detect installed apps
            </Button>
            <Button onClick={() => scanDesktop('pick')} disabled={busy} variant="secondary">
              <FileUp className="h-3.5 w-3.5" />
              Choose file…
            </Button>
          </div>
        )}
        {!scan && !desktop && (
          <div className="flex flex-col gap-2">
            <Textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={8}
              spellCheck={false}
              aria-label="MCP config JSON"
              placeholder={'{ "mcpServers": { "my-server": { "url": "https://…" } } }'}
            />
            <div className="flex items-center gap-2">
              <Button
                onClick={() => scanWeb(pasted, 'Pasted config')}
                disabled={pasted.trim() === ''}
              >
                Preview
              </Button>
              <label className="text-sp-12 text-sp-dim">
                <span className="mr-2">or upload</span>
                <input
                  type="file"
                  accept=".json,.jsonc,application/json"
                  aria-label="Upload MCP config"
                  onChange={(event) => void onUpload(event.target.files?.[0])}
                />
              </label>
            </div>
          </div>
        )}
        {notice && (
          <p className="text-sp-12 text-amber-400" role="status">
            {notice}
          </p>
        )}

        {scan && (
          <div className="max-h-[50vh] overflow-y-auto flex flex-col gap-3">
            {scan.sources.map((source, index) => (
              <section key={index}>
                <h3 className="text-sp-12 font-medium text-sp-text">
                  {source.label}
                  {source.location && (
                    <span className="ml-2 font-mono text-sp-11 text-sp-dim">{source.location}</span>
                  )}
                </h3>
                {source.error && (
                  <p className="text-sp-12 text-rose-400" role="alert">
                    {source.error}
                  </p>
                )}
                {source.warnings.map((w, i) => (
                  <p key={i} className="text-sp-11 text-amber-400">
                    {w}
                  </p>
                ))}
                <ul>
                  {source.entries.map((entry) => (
                    <EntryRow
                      key={entry.key}
                      entry={entry}
                      desktop={desktop}
                      checked={selected.has(entry.key)}
                      onToggle={() => toggle(entry.key)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {scan && (
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Back
            </Button>
          )}
          <Button
            onClick={() => void doImport(scan as Scan)}
            disabled={busy || !scan || selected.size === 0}
          >
            Import {selected.size > 0 ? `${selected.size} selected` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
