import { ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { KeyValueTable } from '@/components/shared/KeyValueTable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { getElectronAPI } from '@/lib/shared/platform';
import type { KeyValue, McpStdioConfig, McpStdioEnvVar } from '@/types';

export const EMPTY_STDIO_CONFIG: McpStdioConfig = { command: '', args: [] };

/** One argument per line. Blank lines are dropped at send time (see buildStdioLaunch). */
export function argsToText(args: readonly string[]): string {
  return args.join('\n');
}

export function textToArgs(text: string): string[] {
  return text.split(/\r?\n/);
}

interface McpStdioFieldsProps {
  stdio: McpStdioConfig;
  onChange: (stdio: McpStdioConfig) => void;
  disabled?: boolean;
}

/**
 * Launch settings for the desktop-only stdio transport: arguments, working
 * directory and extra environment. The command itself lives in the main
 * connection bar. Nothing here can approve a launch — the main process shows
 * its own consent dialog before the first start of any new command line.
 */
export function McpStdioFields({ stdio, onChange, disabled }: McpStdioFieldsProps) {
  const env = stdio.env ?? [];
  const secretBacked = env.filter((e) => e.secretRef !== undefined && e.enabled !== false);

  const revokeApprovals = async () => {
    const api = getElectronAPI();
    if (!api?.mcp?.revokeStdioApprovals) return;
    try {
      const { revoked } = await api.mcp.revokeStdioApprovals();
      toast.success(
        revoked === 1 ? 'Forgot 1 saved approval' : `Forgot ${revoked} saved approvals`
      );
    } catch {
      toast.error('Could not clear saved approvals');
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-2 border-t border-sp-line">
      <label className="flex flex-col gap-1">
        <span className="sp-label">Arguments (one per line)</span>
        <Textarea
          value={argsToText(stdio.args)}
          onChange={(event) => onChange({ ...stdio, args: textToArgs(event.target.value) })}
          disabled={disabled}
          rows={3}
          spellCheck={false}
          placeholder={'-y\n@modelcontextprotocol/server-everything'}
          aria-label="stdio arguments"
          className="font-mono text-sp-12"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="sp-label">Working directory (absolute, optional)</span>
        <Input
          value={stdio.cwd ?? ''}
          onChange={(event) => {
            const cwd = event.target.value;
            const { cwd: _cwd, ...rest } = stdio;
            onChange(cwd ? { ...rest, cwd } : rest);
          }}
          disabled={disabled}
          spellCheck={false}
          placeholder="Defaults to your home directory"
          aria-label="stdio working directory"
          className="h-8 font-mono text-sp-12"
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="sp-label">Environment</span>
        <KeyValueTable
          items={env}
          onChange={(items: KeyValue[]) => onChange({ ...stdio, env: items as McpStdioEnvVar[] })}
          itemLabel="environment variable"
          addLabel="Add variable"
          resolvesVariables="connection"
        />
        {secretBacked.length > 0 && (
          <p className="text-sp-11 text-sp-dim">
            From the secret store (resolved by the desktop app at launch):{' '}
            <span className="font-mono">{secretBacked.map((e) => e.key).join(', ')}</span>
          </p>
        )}
      </div>
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-start gap-1.5 text-sp-11 text-sp-dim">
          <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          Restura asks before starting a new command line. The process gets only the variables above
          plus PATH, HOME and locale settings, and is stopped when you disconnect.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={revokeApprovals}
          className="h-7 px-2 text-sp-11 shrink-0"
        >
          Forget approvals
        </Button>
      </div>
    </div>
  );
}

interface McpStderrPanelProps {
  stderr: string;
  onClear: () => void;
}

/** Bounded stderr of the running stdio server (the store keeps the last 64 KB). */
export function McpStderrPanel({ stderr, onClear }: McpStderrPanelProps) {
  return (
    <div className="mt-2 rounded-sp-panel border border-sp-line bg-sp-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 h-8 border-b border-sp-line">
        <span className="sp-label flex items-center gap-1.5">
          <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
          Server stderr
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="Clear server stderr"
          className="h-6 px-1.5"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <pre
        className="max-h-32 overflow-auto px-3 py-2 font-mono text-sp-11 text-sp-text whitespace-pre-wrap break-all"
        aria-label="MCP server stderr"
      >
        {stderr}
      </pre>
    </div>
  );
}
