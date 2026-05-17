import { Globe, Settings2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/shared/utils';
import { motion } from '@/components/ui/motion';
import { isElectron } from '@/lib/shared/platform';
import type { RequestMode } from '@/types';

interface TopBarProps {
  requestMode: RequestMode;
  onRequestModeChange: (mode: RequestMode) => void;
  onOpenImport: () => void;
  setEnvManagerOpen: (open: boolean) => void;
}

const MODE_LABELS: Record<RequestMode, string> = {
  http: 'HTTP',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  websocket: 'WS',
  socketio: 'Socket.IO',
  sse: 'SSE',
  mcp: 'MCP',
  kafka: 'Kafka',
};

// Modes that can't run in the web build (no Node TCP from Cloudflare Workers).
// The picker still surfaces them so users discover the feature, but the
// button is disabled with a tooltip when not in Electron.
const DESKTOP_ONLY_MODES: ReadonlyArray<RequestMode> = ['kafka'];

export default function TopBar({
  requestMode,
  onRequestModeChange,
  onOpenImport,
  setEnvManagerOpen,
}: TopBarProps) {
  const { environments, activeEnvironmentId, setActiveEnvironment } = useEnvironmentStore(
    useShallow((s) => ({ environments: s.environments, activeEnvironmentId: s.activeEnvironmentId, setActiveEnvironment: s.setActiveEnvironment }))
  );
  const handleModeChange = (mode: RequestMode) => {
    onRequestModeChange(mode);
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-11 items-center justify-between border-b glass-border-default glass-2 px-3 shrink-0">
        {/* Left: Mode switcher */}
        <div role="group" aria-label="Request mode" className="flex items-center gap-0.5 bg-black/[0.06] dark:bg-white/[0.08] glass-border-default rounded-full p-0.5 border">
          {(['http', 'graphql', 'grpc', 'websocket', 'socketio', 'sse', 'mcp', 'kafka'] as RequestMode[]).map((mode) => {
            const desktopOnly = DESKTOP_ONLY_MODES.includes(mode) && !isElectron();
            const button = (
              <button
                key={mode}
                onClick={() => !desktopOnly && handleModeChange(mode)}
                disabled={desktopOnly}
                className={cn(
                  'relative px-3 py-1 text-xs font-medium rounded-full tracking-wide transition-colors duration-150',
                  desktopOnly && 'opacity-40 cursor-not-allowed',
                  requestMode === mode ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                aria-label={`Switch to ${MODE_LABELS[mode]} mode`}
                aria-pressed={requestMode === mode}
              >
                {requestMode === mode && (
                  <motion.span
                    layoutId="mode-pill"
                    className="absolute inset-0 bg-black/[0.06] dark:bg-white/[0.12] shadow-sm rounded-full"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  />
                )}
                <span className="relative z-10">{MODE_LABELS[mode]}</span>
              </button>
            );
            if (desktopOnly) {
              return (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>{button}</span>
                  </TooltipTrigger>
                  <TooltipContent>Desktop only — install the Restura app</TooltipContent>
                </Tooltip>
              );
            }
            return button;
          })}
        </div>

        {/* Right: Env selector + actions */}
        <div className="flex items-center gap-1">
          {/* Environment selector */}
          <Select
            value={activeEnvironmentId ?? 'none'}
            onValueChange={(value) => setActiveEnvironment(value === 'none' ? null : value)}
          >
            <SelectTrigger className="h-7 w-40 text-xs">
              <div className="flex items-center gap-1.5 overflow-hidden">
                <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">
                  {activeEnvironmentId
                    ? (environments.find((e) => e.id === activeEnvironmentId)?.name ?? 'No Environment')
                    : 'No Environment'}
                </span>
              </div>
            </SelectTrigger>
            <SelectContent align="end" className="w-56">
              <SelectItem value="none">No Environment</SelectItem>
              {environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  <div className="flex items-center justify-between w-full gap-2">
                    <span className="truncate">{env.name}</span>
                    {env.variables.length > 0 && (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] min-w-6 justify-center">
                        {env.variables.filter((v) => v.enabled).length}
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setEnvManagerOpen(true)}
                className="h-7 w-7 text-muted-foreground"
                aria-label="Manage Environments"
              >
                <Settings2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage Environments</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenImport}
                className="h-7 w-7 text-muted-foreground"
                aria-label="Import collection"
              >
                <FolderOpen className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Import</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
