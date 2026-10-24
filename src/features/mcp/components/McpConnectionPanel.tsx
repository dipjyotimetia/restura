import { ChevronDown, ChevronRight, PanelLeft, Play, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import { KeyValueTable } from '@/components/shared/KeyValueTable';
import { VariableUrlInput } from '@/components/shared/VariableUrlInput';
import { Button } from '@/components/ui/button';
import { Floater, ProtoChip, Segmented, VariableText } from '@/components/ui/spatial';
import { McpAuthPanel } from '@/features/mcp/components/McpAuthPanel';
import {
  EMPTY_STDIO_CONFIG,
  McpStderrPanel,
  McpStdioFields,
} from '@/features/mcp/components/McpStdioFields';
import { MCP_STDIO_WEB_ERROR } from '@/features/mcp/lib/mcpStdioLaunch';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import type { AuthConfig, KeyValue, McpStdioConfig, McpTransportType } from '@/types';

interface McpConnectionPanelProps {
  connection: McpConnection;
  showCatalog: boolean;
  onToggleCatalog: () => void;
  onUrlChange: (url: string) => void;
  onTransportChange: (transport: McpTransportType) => void;
  onHeadersChange: (headers: KeyValue[]) => void;
  /** stdio launch config (desktop only); undefined until first edited. */
  stdio?: McpStdioConfig | undefined;
  onStdioChange?: (stdio: McpStdioConfig) => void;
  onClearStderr?: () => void;
  /** The tab's MCP request id (drives folder/collection auth inheritance). */
  requestId: string;
  auth: AuthConfig;
  onAuthChange: (auth: AuthConfig) => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const remoteTransportOptions: Array<{ value: McpTransportType; label: string }> = [
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'http-sse', label: 'HTTP + SSE' },
];
const stdioTransportOption = { value: 'stdio' as const, label: 'stdio' };

/** stdio spawns a local process: offered only where the capability exists (desktop). */
export function mcpTransportOptions(desktop: boolean) {
  return isCapableHere('mcp.stdio', desktop)
    ? [...remoteTransportOptions, stdioTransportOption]
    : remoteTransportOptions;
}

/** Connection configuration and lifecycle controls. The request builder owns the client instance. */
export function McpConnectionPanel({
  connection,
  showCatalog,
  onToggleCatalog,
  onUrlChange,
  onTransportChange,
  onHeadersChange,
  stdio,
  onStdioChange,
  onClearStderr,
  requestId,
  auth,
  onAuthChange,
  onConnect,
  onDisconnect,
  onRefresh,
}: McpConnectionPanelProps) {
  const [headersOpen, setHeadersOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const isConnected = connection.status === 'connected';
  const isBusy = connection.status === 'connecting';
  const isError = connection.status === 'error';
  const desktop = isElectron();
  const isStdio = connection.transport === 'stdio';
  const stdioConfig = stdio ?? EMPTY_STDIO_CONFIG;
  const updateStdio = (next: McpStdioConfig) => onStdioChange?.(next);
  const canConnect = isStdio
    ? desktop && stdioConfig.command.trim() !== ''
    : connection.url.trim() !== '';

  return (
    <>
      <div className="px-3 pt-3 pb-2 shrink-0">
        <Floater
          radius="pill"
          elevation="float"
          className="flex items-center gap-2 px-2 min-h-11 py-1.5 bg-sp-surface border border-sp-line flex-wrap"
        >
          <ProtoChip protocol="MCP" />
          <span className="text-sp-dim font-mono text-sp-13 select-none">›</span>
          {isStdio ? (
            <VariableUrlInput
              placeholder="Command, e.g. npx or /usr/local/bin/my-mcp-server"
              value={stdioConfig.command}
              onValueChange={(command) => updateStdio({ ...stdioConfig, command })}
              variableScope="connection"
              disabled={isBusy || isConnected}
              aria-label="MCP stdio command"
              className="flex-1 min-w-[140px] h-7"
              textClassName="px-1 text-sp-12 placeholder:italic"
            />
          ) : isConnected ? (
            <div className="flex-1 min-w-[140px] px-1 font-mono text-sp-12 text-sp-text truncate">
              <VariableText text={connection.url} emptyLabel="No URL" />
            </div>
          ) : (
            <VariableUrlInput
              placeholder="https://mcp.example.com/v1/server"
              value={connection.url}
              onValueChange={onUrlChange}
              variableScope="connection"
              disabled={isBusy}
              aria-label="MCP server URL"
              className="flex-1 min-w-[140px] h-7"
              textClassName="px-1 text-sp-12 placeholder:italic"
            />
          )}
          <ConnectionPill status={connection.status} />
          {isConnected && connection.capabilities?.protocolVersion && (
            <span
              className="inline-flex items-center h-6 px-2 rounded-sp-btn font-mono text-sp-11 text-sp-dim border border-sp-line"
              title="Negotiated MCP protocol version"
              data-testid="mcp-protocol-version"
            >
              v{connection.capabilities.protocolVersion}
            </span>
          )}
          {isConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isBusy}
                className="h-7 px-2.5 text-sp-12 rounded-sp-btn"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDisconnect}
                className="h-7 px-2.5 text-sp-12 rounded-sp-btn text-rose-400 hover:text-rose-300"
              >
                <Square className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              variant="cta"
              size="cta"
              onClick={onConnect}
              loading={isBusy}
              disabled={!canConnect}
            >
              <Play className="h-3.5 w-3.5" />
              Connect
            </Button>
          )}
        </Floater>

        {isError && connection.lastError && (
          <div
            className="mt-2 px-3 py-2 text-sp-12 rounded-sp-btn border"
            style={{
              color: 'var(--color-danger)',
              background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
              borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
            }}
            role="alert"
          >
            {connection.lastError}
          </div>
        )}
        {isStdio && !desktop && (
          <p className="mt-2 px-3 text-sp-12 text-sp-dim" role="note">
            {MCP_STDIO_WEB_ERROR}.
          </p>
        )}
        {isStdio && connection.stderr && (
          <McpStderrPanel stderr={connection.stderr} onClear={() => onClearStderr?.()} />
        )}
      </div>

      <div className="px-3 pb-2 shrink-0 flex items-stretch gap-2">
        <div className="flex items-center px-2 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line">
          <Segmented<McpTransportType>
            options={mcpTransportOptions(desktop)}
            value={connection.transport}
            onChange={onTransportChange}
            size="sm"
            ariaLabel="MCP transport"
            className={cn((isConnected || isBusy) && 'opacity-60 pointer-events-none')}
          />
        </div>
        <Button
          variant={showCatalog ? 'secondary' : 'ghost'}
          size="sm"
          onClick={onToggleCatalog}
          aria-pressed={showCatalog}
          title={showCatalog ? 'Hide catalog' : 'Browse tools, resources & prompts'}
          className="h-9 px-3 text-sp-12 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line"
        >
          <PanelLeft className="h-3.5 w-3.5" />
          Tools
        </Button>
        <Floater
          radius="panel"
          elevation="float"
          className="flex-1 min-w-0 bg-sp-surface border border-sp-line overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setHeadersOpen((open) => !open)}
            className="w-full flex items-center justify-between px-3 h-9 hover:bg-sp-hover"
            aria-expanded={headersOpen}
          >
            <span className="sp-label">
              {isStdio ? 'Launch settings' : 'Headers'}
              {!isStdio && connection.headers.length > 0 && (
                <span className="ml-1.5 font-mono normal-case text-sp-dim">
                  ({connection.headers.length})
                </span>
              )}
            </span>
            {headersOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-sp-dim" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-sp-dim" />
            )}
          </button>
          {headersOpen && isStdio && (
            <McpStdioFields
              stdio={stdioConfig}
              onChange={updateStdio}
              disabled={isBusy || isConnected}
            />
          )}
          {headersOpen && !isStdio && (
            <div className="px-3 py-2 border-t border-sp-line">
              <KeyValueTable
                items={connection.headers}
                onChange={onHeadersChange}
                itemLabel="header"
                addLabel="Add header"
                resolvesVariables="connection"
                httpHeaders
              />
            </div>
          )}
        </Floater>
      </div>

      <div className="px-3 pb-2 shrink-0">
        <Floater
          radius="panel"
          elevation="float"
          className="bg-sp-surface border border-sp-line overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setAuthOpen((open) => !open)}
            className="w-full flex items-center justify-between px-3 h-9 hover:bg-sp-hover"
            aria-expanded={authOpen}
          >
            <span className="sp-label">
              Auth
              {auth.type !== 'none' && (
                <span className="ml-1.5 font-mono normal-case text-sp-dim">({auth.type})</span>
              )}
            </span>
            {authOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-sp-dim" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-sp-dim" />
            )}
          </button>
          {authOpen && (
            <div className="px-3 py-3 border-t border-sp-line">
              <McpAuthPanel
                requestId={requestId}
                auth={auth}
                onChange={onAuthChange}
                disabled={isConnected || isBusy}
                serverUrl={connection.url}
              />
            </div>
          )}
        </Floater>
      </div>
    </>
  );
}

function ConnectionPill({ status }: { status: McpConnection['status'] }) {
  const style: { color: string; bg: string; glow?: string; label: string } = (() => {
    switch (status) {
      case 'connected':
        return {
          color: 'var(--color-success)',
          bg: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
          glow: '0 0 8px color-mix(in srgb, var(--color-success) 45%, transparent)',
          label: 'CONNECTED',
        };
      case 'connecting':
        return {
          color: 'var(--color-warning)',
          bg: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
          label: 'CONNECTING',
        };
      case 'error':
        return {
          color: 'var(--color-danger)',
          bg: 'color-mix(in srgb, var(--color-danger) 18%, transparent)',
          label: 'ERROR',
        };
      default:
        return {
          color: 'var(--color-neutral)',
          bg: 'color-mix(in srgb, var(--color-neutral) 16%, transparent)',
          label: 'OFFLINE',
        };
    }
  })();

  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2 rounded-sp-btn font-mono font-bold text-sp-10 tracking-wider"
      style={{
        color: style.color,
        background: style.bg,
        ...(style.glow ? { boxShadow: style.glow } : {}),
      }}
      aria-label={`MCP status: ${status}`}
    >
      <span aria-hidden="true">●</span>
      {style.label}
    </span>
  );
}
