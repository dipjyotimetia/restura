'use client';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { Moon, Sun, FolderOpen, Globe, Settings2, Command } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import EnvironmentManager from './EnvironmentManager';
import ImportDialog from './ImportDialog';
import SettingsDialog from './SettingsDialog';
import CollectionRunner from './CollectionRunner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

type RequestMode = 'http' | 'grpc' | 'websocket';

interface HeaderProps {
  requestMode: RequestMode;
  onRequestModeChange: (mode: RequestMode) => void;
  onOpenEnvironments?: () => void;
  onOpenSettings?: () => void;
  onOpenImport?: () => void;
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
  onOpenEnvironments: _onOpenEnvironments,
  onOpenSettings,
  onOpenImport: _onOpenImport,
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
  const { createNewHttpRequest, createNewGrpcRequest } = useRequestStore();

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
    if (mode === 'http') {
      createNewHttpRequest();
    } else if (mode === 'grpc') {
      createNewGrpcRequest();
    }
    // WebSocket doesn't use the request store
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
    <header className="relative z-50 flex h-14 items-center justify-between border-b border-border bg-background px-6 shadow-sm">
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

        {/* Request Mode Selector */}
        <div className="flex items-center gap-2">
          <Select value={requestMode} onValueChange={(v) => handleRequestModeChange(v as RequestMode)}>
            <SelectTrigger className="h-8 w-[130px] border-0 bg-transparent px-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground focus:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="http">HTTP/REST</SelectItem>
              <SelectItem value="grpc">gRPC</SelectItem>
              <SelectItem value="websocket">WebSocket</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2">
          {/* Environment Selector */}
          <div className="flex items-center gap-2">
            <Select
              value={activeEnvironmentId || 'none'}
              onValueChange={(value) => setActiveEnvironment(value === 'none' ? null : value)}
            >
              <SelectTrigger className="h-8 w-[150px] border-0 bg-transparent px-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground focus:ring-0">
                <SelectValue placeholder="No Environment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Environment</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    <div className="flex items-center gap-2">
                      {env.name}
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {env.variables.filter(v => v.enabled).length}
                      </Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setEnvManagerOpen(true)}
                  aria-label="Manage environments"
                >
                  <Globe className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Manage Environments</p>
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="h-4 w-px bg-border mx-1" />

          {/* Collection Runner */}
          <CollectionRunner />

          {/* Import Collection Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
                className="h-8 text-xs font-medium"
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                Import
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Import collection from file</p>
            </TooltipContent>
          </Tooltip>

          {/* Command Palette Hint */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="hidden md:flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[10px] font-medium cursor-help">
                <Command className="h-3 w-3" />
                <span>K</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Open Command Palette (⌘K)</p>
            </TooltipContent>
          </Tooltip>

          {/* Settings Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onOpenSettings || (() => setSettingsOpen(true))}
                aria-label="Open settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Settings (⌘,)</p>
            </TooltipContent>
          </Tooltip>

          {/* Theme Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={toggleTheme}
                aria-label="Toggle theme"
              >
                {mounted && (theme === 'dark' || resolvedTheme === 'dark') ? (
                  <Sun className="h-4 w-4 transition-transform duration-300 hover:rotate-180" />
                ) : (
                  <Moon className="h-4 w-4 transition-transform duration-300 hover:-rotate-12" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Toggle theme</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      {/* Dialogs */}
      <EnvironmentManager open={envManagerOpen} onOpenChange={setEnvManagerOpen} />
      <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
