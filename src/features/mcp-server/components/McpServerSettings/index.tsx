/**
 * Settings → MCP Server. Everything an agent can see or do is decided here:
 * the on/off switch, the approval mode, per-collection and per-environment
 * access, and the activity log with Undo. Also shows copy-ready configs for
 * Claude Code, Codex and Claude Desktop.
 */

import { setHistoryConsent } from '@shared/mcp-server/consent';
import type { McpApprovalMode } from '@shared/mcp-server/settings';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleField } from '@/components/ui/spatial';
import { isElectron } from '@/lib/shared/platform';
import {
  updateMcpConsent,
  updateMcpServerSettings,
  useMcpServerSettings,
} from '../../lib/settings';
import { useMcpServerRuntimeStore } from '../../store/useMcpServerRuntimeStore';
import { AccessGroups } from './AccessGroups';
import { ActivityLog } from './ActivityLog';
import { ConnectAgent } from './ConnectAgent';
import type { SettingsPrimitives } from './primitives';

export interface McpServerSettingsProps extends SettingsPrimitives {
  Header: (props: { icon: typeof Bot; title: string; description: string }) => ReactNode;
}

function relativeTime(at: number | undefined): string {
  if (!at) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(at).toLocaleTimeString();
}

export function McpServerSettings({ Header, Group, Row }: McpServerSettingsProps) {
  const settings = useMcpServerSettings();
  const status = useMcpServerRuntimeStore((s) => s.status);
  const lastError = useMcpServerRuntimeStore((s) => s.lastError);

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
          hint="Deletes, sends and scripts always ask. Every agent change is listed below with Undo."
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

      <AccessGroups settings={settings} Group={Group} Row={Row} />
      <ConnectAgent Group={Group} />
      <ActivityLog Group={Group} />
    </>
  );
}
