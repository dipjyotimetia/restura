/**
 * Copy-ready agent configs (Settings → MCP Server). The command comes from
 * main (`agentLaunchCommand`), which knows the stable path for this install:
 * the AppImage / portable launcher, or the dev entry for an unpackaged build.
 */

import { Info, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { type AgentLaunch, useMcpServerRuntimeStore } from '../../store/useMcpServerRuntimeStore';
import { startMcpControlServer } from '../McpControlBridge';
import { CopyBlock, type SettingsPrimitives } from './primitives';

/** Seconds an agent should wait for a tool call: approvals can take minutes. */
export const AGENT_TOOL_TIMEOUT_SEC = 600;

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function agentConfigs(launch: AgentLaunch) {
  const env = Object.entries(launch.env ?? {});
  const claudeCode = [
    'claude mcp add restura',
    ...env.map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`),
    '--',
    shellQuote(launch.command),
    ...launch.args.map(shellQuote),
  ].join(' ');
  const codex = [
    '[mcp_servers.restura]',
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    // Approvals wait for the user; Codex's default per-tool timeout is short.
    `tool_timeout_sec = ${AGENT_TOOL_TIMEOUT_SEC}`,
    ...(env.length > 0
      ? [`env = { ${env.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`]
      : []),
  ].join('\n');
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        restura: {
          command: launch.command,
          args: launch.args,
          ...(env.length > 0 ? { env: Object.fromEntries(env) } : {}),
        },
      },
    },
    null,
    2
  );
  return { claudeCode, codex, claudeDesktop };
}

export function ConnectAgent({ Group }: Pick<SettingsPrimitives, 'Group'>) {
  const { status, token, launch } = useMcpServerRuntimeStore();
  const [showToken, setShowToken] = useState(false);
  const configs = agentConfigs(launch ?? { command: '/path/to/Restura', args: ['--mcp-server'] });
  const httpCommand =
    status.url && token
      ? `claude mcp add --transport http restura ${status.url} --header "Authorization: Bearer ${
          showToken ? token : '<token>'
        }"`
      : null;

  return (
    <Group label="Connect an agent">
      <CopyBlock label="Claude Code" text={configs.claudeCode} testId="mcp-config-claude-code" />
      <CopyBlock label="Codex (~/.codex/config.toml)" text={configs.codex} />
      <CopyBlock label="Claude Desktop (claude_desktop_config.json)" text={configs.claudeDesktop} />
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
        The stdio command relays to this running app and reads its token from your user data folder,
        so no secret goes into the agent&rsquo;s config. Keep Restura open while the agent works.
        The HTTP token changes every time the server starts. Approvals can take a while: give the
        agent a long tool timeout (the Codex snippet sets one).
      </p>
    </Group>
  );
}
