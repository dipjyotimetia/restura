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

  const { theme, setTheme } = useTheme();
  const { environments, activeEnvironmentId, setActiveEnvironment } = useEnvironmentStore();
  const { createNewHttpRequest, createNewGrpcRequest } = useRequestStore();

  useEffect(() => {
    setMounted(true);
  }, []);

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
      <header className="relative z-50 flex h-14 items-center justify-between border-b border-slate-200/60 dark:border-slate-700/50 bg-white/50 dark:bg-slate-900/50 backdrop-blur-xl px-6 shadow-inner-bottom noise-texture">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-slate-blue-500 to-indigo-600 shadow-lg shadow-slate-blue-500/20">
              <span className="text-base font-bold text-white">R</span>
            </div>
            <div className="flex flex-col gap-0">
              <h1 className="text-base font-semibold tracking-tighter bg-gradient-to-r from-slate-blue-600 to-indigo-600 dark:from-slate-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">Restura</h1>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide uppercase">Multi-Protocol</span>
            </div>
          </div>
          <div className="h-6 w-px bg-slate-200 dark:bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Mode</span>
            <div className="w-[140px] h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Env</span>
            <div className="w-[160px] h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
            <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
          </div>
          <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
          <div className="w-20 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
          <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
          <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
        </div>
      </header>
    );
  }

  return (
    <header className="relative z-50 flex h-14 items-center justify-between border-b border-slate-200/60 dark:border-slate-700/50 bg-white/80 dark:bg-[hsl(var(--background)_/_0.75)] backdrop-blur-md px-6 shadow-inner-bottom noise-texture">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-slate-blue-500 to-indigo-600 shadow-lg shadow-slate-blue-500/20 transition-transform hover:scale-105">
            <span className="text-base font-bold text-white">R</span>
          </div>
          <div className="flex flex-col gap-0">
            <h1 className="text-base font-semibold tracking-tighter bg-gradient-to-r from-slate-blue-600 to-indigo-600 dark:from-slate-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">Restura</h1>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide uppercase">Multi-Protocol</span>
          </div>
        </div>

        <div className="h-6 w-px bg-slate-200 dark:bg-slate-700" />

        {/* Request Mode Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Mode</span>
          <Select value={requestMode} onValueChange={(v) => handleRequestModeChange(v as RequestMode)}>
            <SelectTrigger className="w-[140px] h-8 bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:shadow-elevation-1 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-slate-200 dark:border-slate-700">
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
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Env</span>
            <Select
              value={activeEnvironmentId || 'none'}
              onValueChange={(value) => setActiveEnvironment(value === 'none' ? null : value)}
            >
              <SelectTrigger className="w-[160px] h-8 bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:shadow-elevation-1 text-sm">
                <SelectValue placeholder="No Environment" />
              </SelectTrigger>
              <SelectContent className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-slate-200 dark:border-slate-700">
                <SelectItem value="none">No Environment</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    <div className="flex items-center gap-2">
                      {env.name}
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-5 bg-slate-blue-50 dark:bg-slate-blue-950/30 border-slate-blue-200 dark:border-slate-blue-800 text-slate-blue-700 dark:text-slate-blue-300">
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

          <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1" />

          {/* Import Collection Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
                className="h-8 text-xs"
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
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
              <div className="hidden md:flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs font-medium cursor-help hover:border-slate-blue-300 dark:hover:border-slate-blue-700 transition-colors">
                <Command className="h-3.5 w-3.5" />
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
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4 transition-transform duration-300 hover:rotate-180" />
                ) : (
                  <Moon className="h-4 w-4 transition-transform duration-300 hover:-rotate-12" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}</p>
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
