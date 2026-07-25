import { PanelLeftClose, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Floater, SubTabBar, SubTabPanel } from '@/components/ui/spatial';
import type { McpInvocationLog } from '@/features/mcp/store/useMcpStore';
import { cn } from '@/lib/shared/utils';
import type {
  McpJsonSchema,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '@/types';

export type McpDiscoveryTab = 'tools' | 'resources' | 'prompts' | 'log';

interface McpDiscoveryPanelProps {
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
  log: McpInvocationLog[];
  selectedToolName: string | null;
  selectedPromptName: string | null;
  onToolSelect: (name: string) => void;
  onPromptSelect: (name: string) => void;
  onReadResource: (uri: string) => Promise<void>;
  onClearLog: () => void;
  onHide: () => void;
  tab: McpDiscoveryTab;
  onTabChange: (tab: McpDiscoveryTab) => void;
}

/** MCP capability browser. Selection stays in the builder so the invoke form remains visible beside it. */
export function McpDiscoveryPanel({
  tools,
  resources,
  prompts,
  log,
  selectedToolName,
  selectedPromptName,
  onToolSelect,
  onPromptSelect,
  onReadResource,
  onClearLog,
  onHide,
  tab,
  onTabChange,
}: McpDiscoveryPanelProps) {
  return (
    <Floater
      radius="panel"
      elevation="float"
      className="w-75 shrink-0 bg-sp-surface border border-sp-line flex flex-col overflow-hidden min-h-0"
    >
      <SubTabBar<McpDiscoveryTab>
        tabs={[
          { value: 'tools', label: 'Tools', count: tools.length },
          { value: 'resources', label: 'Resources', count: resources.length },
          { value: 'prompts', label: 'Prompts', count: prompts.length },
          { value: 'log', label: 'Log', count: log.length },
        ]}
        value={tab}
        onChange={onTabChange}
        className="border-b-0"
        right={
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide catalog"
            title="Hide catalog"
            className="flex items-center justify-center h-6 w-6 rounded-sp-btn text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        }
      />
      <SubTabPanel tabKey={tab} className="flex-1 min-h-0 overflow-hidden">
        {tab === 'tools' && (
          <ToolList tools={tools} selected={selectedToolName} onSelect={onToolSelect} />
        )}
        {tab === 'resources' && <ResourceList resources={resources} onRead={onReadResource} />}
        {tab === 'prompts' && (
          <PromptList prompts={prompts} selected={selectedPromptName} onSelect={onPromptSelect} />
        )}
        {tab === 'log' && <LogList log={log} onClear={onClearLog} />}
      </SubTabPanel>
    </Floater>
  );
}

function countArgs(schema: McpJsonSchema | undefined): number {
  return schema?.properties ? Object.keys(schema.properties).length : 0;
}

function ToolList({
  tools,
  selected,
  onSelect,
}: {
  tools: McpToolDescriptor[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (tools.length === 0) {
    return <EmptyState title="No tools" hint="Connect to a server to discover tools." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {tools.map((tool) => {
          const isSelected = selected === tool.name;
          const argCount = countArgs(tool.inputSchema);
          return (
            <button
              key={tool.name}
              type="button"
              onClick={() => onSelect(tool.name)}
              className={cn(
                'w-full text-left rounded-sp-btn px-2.5 py-2 transition-colors group',
                'border border-transparent',
                isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
              )}
              style={isSelected ? { borderColor: 'var(--sp-accent-glow-55)' } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Sparkles
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--color-warning)' }}
                  />
                  <span className="font-mono font-bold text-sp-12 text-sp-text truncate">
                    {tool.name}
                  </span>
                </div>
                <span className="sp-label shrink-0">
                  {argCount} {argCount === 1 ? 'arg' : 'args'}
                </span>
              </div>
              {tool.description && (
                <div className="mt-1 ml-5 text-sp-11-5 text-sp-muted line-clamp-2">
                  {tool.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function ResourceList({
  resources,
  onRead,
}: {
  resources: McpResourceDescriptor[];
  onRead: (uri: string) => Promise<void>;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const handleRead = async (uri: string) => {
    setReading(uri);
    try {
      await onRead(uri);
    } finally {
      setReading(null);
    }
  };

  if (resources.length === 0) {
    return <EmptyState title="No resources" hint="The server exposes no resources." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {resources.map((resource) => (
          <div
            key={resource.uri}
            className="rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2.5 space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono font-bold text-sp-12 text-sp-text truncate">
                  {resource.name}
                </div>
                <div className="text-sp-11 font-mono text-sp-dim truncate">{resource.uri}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRead(resource.uri)}
                loading={reading === resource.uri}
                className="h-6 px-2 text-sp-11 rounded-sp-btn shrink-0"
              >
                Read
              </Button>
            </div>
            {resource.description && (
              <p className="text-sp-11-5 text-sp-muted line-clamp-2">{resource.description}</p>
            )}
            {resource.mimeType && <span className="sp-label inline-flex">{resource.mimeType}</span>}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function PromptList({
  prompts,
  selected,
  onSelect,
}: {
  prompts: McpPromptDescriptor[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (prompts.length === 0) {
    return <EmptyState title="No prompts" hint="The server exposes no prompts." />;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {prompts.map((prompt) => {
          const isSelected = selected === prompt.name;
          const argCount = prompt.arguments?.length ?? 0;
          return (
            <button
              key={prompt.name}
              type="button"
              onClick={() => onSelect(prompt.name)}
              className={cn(
                'w-full text-left rounded-sp-btn px-2.5 py-2 transition-colors',
                'border border-transparent',
                isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
              )}
              style={isSelected ? { borderColor: 'var(--sp-accent-glow-55)' } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Sparkles
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--color-warning)' }}
                  />
                  <span className="font-mono font-bold text-sp-12 text-sp-text truncate">
                    {prompt.name}
                  </span>
                </div>
                <span className="sp-label shrink-0">
                  {argCount} {argCount === 1 ? 'arg' : 'args'}
                </span>
              </div>
              {prompt.description && (
                <div className="mt-1 ml-5 text-sp-11-5 text-sp-muted line-clamp-2">
                  {prompt.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function LogList({ log, onClear }: { log: McpInvocationLog[]; onClear: () => void }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 h-9 border-b border-sp-line shrink-0">
        <span className="sp-label">{log.length} CALLS</span>
        <button
          type="button"
          onClick={onClear}
          disabled={log.length === 0}
          className="inline-flex items-center gap-1 text-sp-11 text-sp-muted hover:text-sp-text disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </button>
      </div>
      {log.length === 0 ? (
        <EmptyState title="No calls yet" hint="Invoke a tool or resource to see calls." />
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 space-y-1">
            {log.map((entry) => {
              const ok = entry.error === undefined;
              return (
                <div
                  key={entry.id}
                  className="rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sp-11-5 text-sp-text truncate">
                      {entry.method}
                    </code>
                    <span
                      className="font-mono text-sp-10 font-bold tracking-wider shrink-0"
                      style={{ color: ok ? 'var(--color-success)' : 'var(--color-danger)' }}
                    >
                      {ok ? 'OK' : 'ERR'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sp-10 text-sp-dim font-mono tabular-nums">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-sp-10 text-sp-dim font-mono tabular-nums">
                      {entry.durationMs.toFixed(0)}ms
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="h-full grid place-items-center px-4">
      <div className="text-center">
        <div className="font-mono text-sp-12 text-sp-muted">{title}</div>
        {hint && <div className="mt-1 text-sp-11-5 text-sp-dim">{hint}</div>}
      </div>
    </div>
  );
}
