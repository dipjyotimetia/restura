import { ChevronDown, ChevronRight, PanelLeft, Play, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Floater, ProtoChip, Segmented, VariableText } from '@/components/ui/spatial';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';
import { cn } from '@/lib/shared/utils';
import type { KeyValue, McpTransportType } from '@/types';

interface McpConnectionPanelProps {
  connection: McpConnection;
  showCatalog: boolean;
  onToggleCatalog: () => void;
  onUrlChange: (url: string) => void;
  onTransportChange: (transport: McpTransportType) => void;
  onAddHeader: () => void;
  onUpdateHeader: (headerId: string, updates: Partial<KeyValue>) => void;
  onRemoveHeader: (headerId: string) => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const transportOptions = [
  { value: 'streamable-http' as const, label: 'Streamable HTTP' },
  { value: 'http-sse' as const, label: 'HTTP + SSE' },
];

/** Connection configuration and lifecycle controls. The request builder owns the client instance. */
export function McpConnectionPanel({
  connection,
  showCatalog,
  onToggleCatalog,
  onUrlChange,
  onTransportChange,
  onAddHeader,
  onUpdateHeader,
  onRemoveHeader,
  onConnect,
  onDisconnect,
  onRefresh,
}: McpConnectionPanelProps) {
  const [headersOpen, setHeadersOpen] = useState(false);
  const isConnected = connection.status === 'connected';
  const isBusy = connection.status === 'connecting';
  const isError = connection.status === 'error';

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
          {isConnected ? (
            <div className="flex-1 min-w-[140px] px-1 font-mono text-sp-12 text-sp-text truncate">
              <VariableText text={connection.url} emptyLabel="No URL" />
            </div>
          ) : (
            <Input
              placeholder="https://mcp.example.com/v1/server"
              value={connection.url}
              onChange={(event) => onUrlChange(event.target.value)}
              disabled={isBusy}
              className="flex-1 min-w-[140px] h-7 bg-transparent border-0 font-mono text-sp-12 text-sp-text px-1 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none placeholder:text-sp-dim placeholder:italic"
              aria-label="MCP server URL"
            />
          )}
          <ConnectionPill status={connection.status} />
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
              disabled={!connection.url.trim()}
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
      </div>

      <div className="px-3 pb-2 shrink-0 flex items-stretch gap-2">
        <div className="flex items-center px-2 rounded-sp-panel shrink-0 bg-sp-surface border border-sp-line">
          <Segmented<McpTransportType>
            options={transportOptions}
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
              Headers
              {connection.headers.length > 0 && (
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
          {headersOpen && (
            <div className="px-3 py-2 border-t border-sp-line">
              <KeyValueEditor
                items={connection.headers}
                onAdd={onAddHeader}
                onUpdate={onUpdateHeader}
                onDelete={onRemoveHeader}
                keyPlaceholder="Header name"
                valuePlaceholder="Header value"
                addButtonText="Add header"
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
