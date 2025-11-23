'use client';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { Moon, Sun, FolderOpen, Globe, Settings2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import EnvironmentManager from '@/features/environments/components/EnvironmentManager';
import ImportDialog from './ImportDialog';
import SettingsDialog from './SettingsDialog';
import CollectionRunner from '@/features/collections/components/CollectionRunner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/shared/utils';
import type { RequestMode } from '@/types';

interface HeaderProps {
  requestMode: RequestMode;
  onRequestModeChange: (mode: RequestMode) => void;
  onOpenSettings?: () => void;
  envManagerOpen?: boolean;
  setEnvManagerOpen?: (open: boolean) => void;
  settingsOpen?: boolean;
  setSettingsOpen?: (open: boolean) => void;
  importDialogOpen?: boolean;
  setImportDialogOpen?: (open: boolean) => void;
}

export default function Header({
  requestMode,
  onRequestModeChange,
  onOpenSettings,
  envManagerOpen: externalEnvManagerOpen,
  setEnvManagerOpen: externalSetEnvManagerOpen,
  settingsOpen: externalSettingsOpen,
  setSettingsOpen: externalSetSettingsOpen,
  importDialogOpen: externalImportDialogOpen,
  setImportDialogOpen: externalSetImportDialogOpen,
}: HeaderProps) {
  const [mounted, setMounted] = useState(false);
  const [internalEnvManagerOpen, setInternalEnvManagerOpen] = useState(false);
  const [internalImportDialogOpen, setInternalImportDialogOpen] = useState(false);
  const [internalSettingsOpen, setInternalSettingsOpen] = useState(false);

  // Use external state if provided, otherwise use internal
  const envManagerOpen = externalEnvManagerOpen ?? internalEnvManagerOpen;
  const setEnvManagerOpen = externalSetEnvManagerOpen ?? setInternalEnvManagerOpen;
  const importDialogOpen = externalImportDialogOpen ?? internalImportDialogOpen;
  const setImportDialogOpen = externalSetImportDialogOpen ?? setInternalImportDialogOpen;
  const settingsOpen = externalSettingsOpen ?? internalSettingsOpen;
  const setSettingsOpen = externalSetSettingsOpen ?? setInternalSettingsOpen;

  const { theme, setTheme, resolvedTheme } = useTheme();
  const { environments, activeEnvironmentId, setActiveEnvironment } = useEnvironmentStore();
  const { switchToHttp, switchToGrpc } = useRequestStore();

  useEffect(() => {
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    if (theme === 'dark' || resolvedTheme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  const handleRequestModeChange = (mode: RequestMode) => {
    onRequestModeChange(mode);
    // Switch to the appropriate request type, preserving state
    if (mode === 'http' || mode === 'graphql') {
      switchToHttp();
    } else if (mode === 'grpc') {
      switchToGrpc();
    }
    // WebSocket uses its own store
  };

  if (!mounted) {
    // Return skeleton to maintain layout during SSR
    return (
      <header className="relative z-50 flex h-14 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
              <span className="text-base font-bold">R</span>
            </div>
            <div className="flex flex-col gap-0">
              <h1 className="text-sm font-semibold tracking-tight">Restura</h1>
            </div>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <div className="w-[130px] h-8 bg-muted rounded-md animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <div className="w-[150px] h-8 bg-muted rounded-md animate-pulse" />
            <div className="w-8 h-8 bg-muted rounded-md animate-pulse" />
          </div>
          <div className="h-4 w-px bg-border mx-1" />
          <div className="w-20 h-8 bg-muted rounded-md animate-pulse" />
          <div className="w-8 h-8 bg-muted rounded-md animate-pulse" />
          <div className="w-8 h-8 bg-muted rounded-md animate-pulse" />
        </div>
      </header>
    );
  }

  return (
    <header className="relative z-50 flex h-14 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 shadow-sm transition-all">
      <div className="flex items-center gap-6">
        {/* Logo & Title */}
        <div className="flex items-center gap-2.5 select-none">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm">
            <span className="text-lg font-bold tracking-tighter">R</span>
          </div>
          <span className="font-semibold tracking-tight text-sm hidden sm:inline-block">Restura</span>
        </div>

        <div className="h-6 w-px bg-border/60 hidden sm:block" />

        {/* Request Mode Selector - Segmented Control Style */}
        <div className="flex items-center rounded-lg bg-muted/80 p-0.5 lg:p-1 border border-border/40 shadow-sm backdrop-blur-sm">
            {['http', 'graphql', 'grpc', 'websocket'].map((mode) => (
              <button
                key={mode}
                onClick={() => handleRequestModeChange(mode as RequestMode)}
                className={cn(
                  "relative px-2 lg:px-3 py-1 lg:py-1.5 text-[10px] lg:text-xs font-medium rounded-md transition-all duration-200",
                  requestMode === mode
                    ? "bg-background text-foreground shadow border border-border/50"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                )}
              >
                {mode === 'http' ? 'HTTP' : mode === 'graphql' ? 'GraphQL' : mode === 'grpc' ? 'gRPC' : 'WS'}
              </button>
            ))}
        </div>
      </div>

      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2">
          
          {/* Environment Selector */}
          <div className="flex items-center gap-1 mr-1 lg:mr-2">
            <Select
              value={activeEnvironmentId || 'none'}
              onValueChange={(value) => setActiveEnvironment(value === 'none' ? null : value)}
            >
              <SelectTrigger className="h-7 lg:h-8 w-[120px] lg:w-[160px] border-transparent bg-muted/30 hover:bg-muted/50 focus:ring-0 text-[10px] lg:text-xs">
                <div className="flex items-center gap-1.5 lg:gap-2 overflow-hidden">
                  <Globe className="h-3 lg:h-3.5 w-3 lg:w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{activeEnvironmentId ? environments.find(e => e.id === activeEnvironmentId)?.name : 'No Environment'}</span>
                </div>
              </SelectTrigger>
              <SelectContent align="end" className="w-[200px]">
                <SelectItem value="none">No Environment</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    <div className="flex items-center justify-between w-full gap-2">
                      <span className="truncate">{env.name}</span>
                      {env.variables.length > 0 && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] min-w-[1.5rem] justify-center">
                          {env.variables.filter(v => v.enabled).length}
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
                  className="h-7 w-7 lg:h-8 lg:w-8 text-muted-foreground"
                  aria-label="Manage Environments"
                >
                  <Settings2 className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Manage Environments</TooltipContent>
            </Tooltip>
          </div>

          {/* Divider */}
          <div className="h-4 lg:h-5 w-px bg-border/60 mx-0.5 lg:mx-1" />

          {/* Actions Group */}
          <div className="flex items-center gap-0.5 lg:gap-1">
            <CollectionRunner />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setImportDialogOpen(true)}
                  className="h-7 w-7 lg:h-8 lg:w-8 text-muted-foreground"
                  aria-label="Import collection"
                >
                  <FolderOpen className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Import (⌘I)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onOpenSettings || (() => setSettingsOpen(true))}
                  className="h-7 w-7 lg:h-8 lg:w-8 text-muted-foreground"
                  aria-label="Settings"
                >
                  <Settings2 className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings (⌘,)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleTheme}
                  className="h-7 w-7 lg:h-8 lg:w-8 text-muted-foreground"
                  aria-label="Toggle theme"
                >
                   {mounted && (theme === 'dark' || resolvedTheme === 'dark') ? (
                    <Sun className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
                  ) : (
                    <Moon className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle Theme</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* Dialogs */}
      <EnvironmentManager open={envManagerOpen} onOpenChange={setEnvManagerOpen} />
      <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
