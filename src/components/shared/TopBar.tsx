import { Globe, Settings2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { cn } from '@/lib/shared/utils';
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
};

export default function TopBar({
  requestMode,
  onRequestModeChange,
  onOpenImport,
  setEnvManagerOpen,
}: TopBarProps) {
  const { environments, activeEnvironmentId, setActiveEnvironment } = useEnvironmentStore();
  const { switchToHttp, switchToGrpc } = useRequestStore();

  const handleModeChange = (mode: RequestMode) => {
    onRequestModeChange(mode);
    if (mode === 'http' || mode === 'graphql') {
      switchToHttp();
    } else if (mode === 'grpc') {
      switchToGrpc();
    }
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-11 items-center justify-between border-b border-border bg-background/95 backdrop-blur px-3 shrink-0">
        {/* Left: Mode switcher */}
        <div role="group" aria-label="Request mode" className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5 border border-border/50">
          {(['http', 'graphql', 'grpc', 'websocket'] as RequestMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => handleModeChange(mode)}
              className={cn(
                'px-2.5 py-1 text-[10px] font-medium rounded tracking-wide transition-all duration-150',
                requestMode === mode
                  ? 'bg-background text-foreground shadow-sm border border-border/40'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={`Switch to ${MODE_LABELS[mode]} mode`}
              aria-pressed={requestMode === mode}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>

        {/* Right: Env selector + actions */}
        <div className="flex items-center gap-1">
          {/* Environment selector */}
          <Select
            value={activeEnvironmentId ?? 'none'}
            onValueChange={(value) => setActiveEnvironment(value === 'none' ? null : value)}
          >
            <SelectTrigger className="h-7 w-35 border-transparent bg-muted/30 hover:bg-muted/50 focus:ring-0 text-[10px]">
              <div className="flex items-center gap-1.5 overflow-hidden">
                <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">
                  {activeEnvironmentId
                    ? (environments.find((e) => e.id === activeEnvironmentId)?.name ?? 'No Environment')
                    : 'No Environment'}
                </span>
              </div>
            </SelectTrigger>
            <SelectContent align="end" className="w-45">
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
