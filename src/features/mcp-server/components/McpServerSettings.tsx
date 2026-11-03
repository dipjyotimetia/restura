/**
 * Settings → MCP Server. Everything an agent can see or do is decided here:
 * the on/off switch, the approval mode, per-collection and per-environment
 * access, and the activity log with Undo. Also shows copy-ready configs for
 * Claude Code, Codex and Claude Desktop.
 */

import {
  type CollectionConsentLevel,
  type EnvironmentConsentLevel,
  getConsentLevel,
  getEnvironmentConsentLevel,
  setCollectionConsent,
  setEnvironmentConsent,
  setEnvironmentExecutable,
  setHistoryConsent,
} from '@shared/mcp-server/consent';
import type { McpApprovalMode } from '@shared/mcp-server/settings';
import { Bot, Copy, Info, RotateCw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleField } from '@/components/ui/spatial';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { undoActivity } from '../lib/runtime';
import { updateMcpConsent, updateMcpServerSettings, useMcpServerSettings } from '../lib/settings';
import { type ActivityEntry, useMcpServerRuntimeStore } from '../store/useMcpServerRuntimeStore';
import { startMcpControlServer } from './McpControlBridge';

const COLLECTION_LEVELS: Array<{ value: CollectionConsentLevel; label: string }> = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'read-only', label: 'Read' },
  { value: 'edit', label: 'Read & edit' },
  { value: 'full', label: 'Full (send)' },
];

const ENVIRONMENT_LEVELS: Array<{ value: EnvironmentConsentLevel; label: string }> = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'read-only', label: 'Read' },
  { value: 'edit', label: 'Read & edit' },
];

/** Settings primitives are passed in so this feature does not import the settings feature. */
export interface McpServerSettingsProps {
  Header: (props: { icon: typeof Bot; title: string; description: string }) => React.ReactNode;
  Group: (props: { label: string; children: React.ReactNode }) => React.ReactNode;
  Row: (props: {
    label: string;
    hint?: React.ReactNode;
    control: React.ReactNode;
  }) => React.ReactNode;
}

function CopyBlock({ label, text, testId }: { label: string; text: string; testId?: string }) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sp-12 font-semibold text-sp-text">{label}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast.success(`${label} copied`);
          }}
        >
          <Copy /> Copy
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="mt-2 overflow-x-auto rounded-md bg-sp-surface-lo p-2 font-mono text-sp-11 text-sp-text whitespace-pre"
      >
        {text}
      </pre>
    </div>
  );
}

function LevelSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className="h-7 w-[132px] text-xs" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function relativeTime(at: number | undefined): string {
  if (!at) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(at).toLocaleTimeString();
}

const STATUS_STYLE: Record<ActivityEntry['status'], string> = {
  applied: 'text-emerald-600 dark:text-emerald-400',
  denied: 'text-amber-600 dark:text-amber-400',
  refused: 'text-sp-muted',
  failed: 'text-rose-600 dark:text-rose-400',
  undone: 'text-sp-muted line-through',
};

export function McpServerSettings({ Header, Group, Row }: McpServerSettingsProps) {
  const settings = useMcpServerSettings();
  const { status, token, lastError, activity } = useMcpServerRuntimeStore();
  const collections = useCollectionStore((s) => s.collections);
  const environments = useEnvironmentStore((s) => s.environments);
  const [exePath, setExePath] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    void getElectronAPI()
      ?.app.getPath('exe')
      .then(setExePath)
      .catch(() => setExePath(null));
  }, []);

  const header = (
    <Header
      icon={Bot}
      title="MCP server"
      description="Let Claude, Codex and other MCP agents build and run your API collections — only what you share, with your approval."
    />
  );

  if (!isElectron()) {
    return (
      <>
        {header}
        <p className="text-sm text-sp-muted">
          The MCP server runs inside the Restura desktop app. Install the desktop app to connect an
          agent.
        </p>
      </>
    );
  }

  const exe = exePath ?? '/path/to/Restura';
  const stdioCommand = `claude mcp add restura -- ${shellQuote(exe)} --mcp-server`;
  const codexToml = `[mcp_servers.restura]\ncommand = ${JSON.stringify(exe)}\nargs = ["--mcp-server"]`;
  const desktopJson = JSON.stringify(
    { mcpServers: { restura: { command: exe, args: ['--mcp-server'] } } },
    null,
    2
  );
  const httpCommand =
    status.url && token
      ? `claude mcp add --transport http restura ${status.url} --header "Authorization: Bearer ${
          showToken ? token : '<token>'
        }"`
      : null;

  return (
    <>
      {header}

      <Group label="Server">
        <Row
          label="Enable MCP server"
          hint={
            status.running ? (
              <span data-testid="mcp-server-status">
                Listening on 127.0.0.1:{status.port} · last call {relativeTime(status.lastCallAt)}
                {status.inFlight > 0 ? ` · ${status.inFlight} in progress` : ''}
              </span>
            ) : lastError ? (
              <span className="text-rose-500">{lastError}</span>
            ) : (
              'Off. Agents see nothing while the server is off.'
            )
          }
          control={
            <ToggleField
              checked={settings.enabled}
              onChange={(value) => updateMcpServerSettings({ enabled: value })}
              ariaLabel="Enable MCP server"
            />
          }
        />
        <Row
          label="Approvals"
          hint="Deletes and sends always ask. Every agent change is listed below with Undo."
          control={
            <Select
              value={settings.approvalMode}
              onValueChange={(v) => updateMcpServerSettings({ approvalMode: v as McpApprovalMode })}
            >
              <SelectTrigger className="h-7 w-[190px] text-xs" aria-label="Approval mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask-every-change" className="text-xs">
                  Ask for every change
                </SelectItem>
                <SelectItem value="auto-approve-edits" className="text-xs">
                  Auto-approve edits
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <Row
          label="Redact responses"
          hint="Mask credential headers, token-like fields and JWTs in responses sent to agents."
          control={
            <ToggleField
              checked={settings.redactResponseBodies}
              onChange={(value) => updateMcpServerSettings({ redactResponseBodies: value })}
              ariaLabel="Redact responses sent to agents"
            />
          }
        />
        <Row
          label="Request history"
          hint="Let agents read past requests (URL, status, timing)."
          control={
            <ToggleField
              checked={settings.consent.historyLevel === 'read-only'}
              onChange={(value) =>
                updateMcpConsent((c) => setHistoryConsent(c, value ? 'read-only' : 'hidden'))
              }
              ariaLabel="Share request history with agents"
            />
          }
        />
      </Group>

      <Group label="Collections agents may use">
        <Row
          label="New collections"
          hint="Access for collections without their own setting."
          control={
            <LevelSelect
              value={settings.consent.defaultLevel}
              options={COLLECTION_LEVELS}
              ariaLabel="Default access for collections"
              onChange={(level) => updateMcpConsent((c) => ({ ...c, defaultLevel: level }))}
            />
          }
        />
        {collections.map((collection) => (
          <Row
            key={collection.id}
            label={collection.name}
            control={
              <LevelSelect
                value={getConsentLevel(settings.consent, collection.id)}
                options={COLLECTION_LEVELS}
                ariaLabel={`Agent access for collection ${collection.name}`}
                onChange={(level) =>
                  updateMcpConsent((c) => setCollectionConsent(c, collection.id, level))
                }
              />
            }
          />
        ))}
      </Group>

      <Group label="Environments agents may use">
        {environments.length === 0 && (
          <div className="py-3 text-sp-12 text-sp-muted">No environments yet.</div>
        )}
        {environments.map((environment) => {
          const executable = settings.consent.executableEnvironments?.[environment.id] === true;
          return (
            <Row
              key={environment.id}
              label={environment.name}
              hint={
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={executable}
                    aria-label={`Agents may send with ${environment.name}`}
                    onChange={(e) =>
                      updateMcpConsent((c) =>
                        setEnvironmentExecutable(c, environment.id, e.target.checked)
                      )
                    }
                  />
                  Agents may send with this environment
                  {executable && /prod/i.test(environment.name) ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      {' '}
                      — looks like production
                    </span>
                  ) : null}
                </label>
              }
              control={
                <LevelSelect
                  value={getEnvironmentConsentLevel(settings.consent, environment.id)}
                  options={ENVIRONMENT_LEVELS}
                  ariaLabel={`Agent access for environment ${environment.name}`}
                  onChange={(level) =>
                    updateMcpConsent((c) => setEnvironmentConsent(c, environment.id, level))
                  }
                />
              }
            />
          );
        })}
      </Group>

      <Group label="Connect an agent">
        <CopyBlock label="Claude Code" text={stdioCommand} testId="mcp-config-claude-code" />
        <CopyBlock label="Codex (~/.codex/config.toml)" text={codexToml} />
        <CopyBlock label="Claude Desktop (claude_desktop_config.json)" text={desktopJson} />
        {httpCommand && (
          <div className="py-3">
            <CopyBlock label="Claude Code over HTTP (advanced)" text={httpCommand} />
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide token' : 'Show token'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void startMcpControlServer({ rotateToken: true }).then(() =>
                    toast.success('Token rotated — reconnect HTTP clients')
                  );
                }}
              >
                <RotateCw /> Rotate token
              </Button>
            </div>
          </div>
        )}
        <p className="flex items-start gap-1.5 py-3 text-sp-11-5 text-sp-muted">
          <Info size={13} className="mt-0.5 shrink-0 text-sp-accent" aria-hidden="true" />
          The stdio command relays to this running app and reads its token from your user data
          folder, so no secret goes into the agent&rsquo;s config. Keep Restura open while the agent
          works. The HTTP token changes every time the server starts.
        </p>
      </Group>

      <Group label="Activity">
        {activity.length === 0 ? (
          <div className="py-3 text-sp-12 text-sp-muted" data-testid="mcp-activity-empty">
            No agent changes yet.
          </div>
        ) : (
          <ul className="divide-y divide-sp-line" data-testid="mcp-activity">
            {activity.slice(0, 50).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className={cn('truncate text-sp-12', STATUS_STYLE[entry.status])}>
                    {entry.summary}
                  </div>
                  <div className="truncate text-sp-11 text-sp-muted">
                    {entry.status} · {entry.tool} · {new Date(entry.at).toLocaleTimeString()}
                    {entry.client ? ` · ${entry.client}` : ''}
                    {entry.detail ? ` · ${entry.detail}` : ''}
                  </div>
                </div>
                {entry.undoable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void undoActivity(entry.id).then((done) =>
                        done ? toast.success('Change undone') : toast.error('Can no longer undo')
                      );
                    }}
                  >
                    <Undo2 /> Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Group>
    </>
  );
}
