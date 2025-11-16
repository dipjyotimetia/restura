'use client';

import { useEffect, useState, useCallback } from 'react';
import { Command } from 'cmdk';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  Send,
  Moon,
  Sun,
  Globe,
  FolderOpen,
  Settings2,
  Trash2,
  Plus,
  Code2,
  Wifi,
  Server,
  Copy,
  FileJson,
  Keyboard,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { Separator } from '@/components/ui/separator';

interface CommandPaletteProps {
  onOpenEnvironments?: () => void;
  onOpenSettings?: () => void;
  onOpenImport?: () => void;
  onSendRequest?: () => void;
  onChangeMode?: (mode: 'http' | 'grpc' | 'websocket') => void;
}

export default function CommandPalette({
  onOpenEnvironments,
  onOpenSettings,
  onOpenImport,
  onSendRequest,
  onChangeMode,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { createNewHttpRequest, createNewGrpcRequest, currentResponse } = useRequestStore();
  const { clearHistory } = useHistoryStore();

  // Toggle command palette with Cmd+K
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      command();
    },
    []
  );

  const handleCopyResponse = useCallback(() => {
    if (currentResponse) {
      navigator.clipboard.writeText(currentResponse.body);
    }
  }, [currentResponse]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 glass-strong border-slate-blue-500/20 shadow-glass-lg max-w-[640px]">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-slate-blue-600 dark:[&_[cmdk-group-heading]]:text-slate-blue-400 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4">
          <div className="flex items-center border-b border-slate-blue-500/20 px-3 bg-gradient-to-r from-slate-blue-500/5 to-indigo-500/5">
            <Code2 className="mr-2 h-4 w-4 shrink-0 text-slate-blue-500" />
            <Command.Input
              placeholder="Type a command or search..."
              className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden">
            <Command.Empty className="py-6 text-center text-sm">
              No results found.
            </Command.Empty>

            <Command.Group heading="Actions">
              {onSendRequest && (
                <Command.Item
                  onSelect={() => runCommand(onSendRequest)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 transition-colors"
                >
                  <Send className="mr-2 h-4 w-4" />
                  <span>Send Request</span>
                  <kbd className="ml-auto text-xs tracking-widest bg-muted px-1.5 py-0.5 rounded text-muted-foreground">⌘↵</kbd>
                </Command.Item>
              )}
              <Command.Item
                onSelect={() => runCommand(createNewHttpRequest)}
                className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
              >
                <Plus className="mr-2 h-4 w-4" />
                <span>New HTTP Request</span>
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(createNewGrpcRequest)}
                className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
              >
                <Plus className="mr-2 h-4 w-4" />
                <span>New gRPC Request</span>
              </Command.Item>
              {currentResponse && (
                <Command.Item
                  onSelect={() => runCommand(handleCopyResponse)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                >
                  <Copy className="mr-2 h-4 w-4" />
                  <span>Copy Response Body</span>
                  <kbd className="ml-auto text-xs tracking-widest bg-muted px-1.5 py-0.5 rounded text-muted-foreground">⌘⇧C</kbd>
                </Command.Item>
              )}
            </Command.Group>

            <Separator className="my-2 bg-slate-blue-500/10" />

            <Command.Group heading="Request Mode">
              {onChangeMode && (
                <>
                  <Command.Item
                    onSelect={() => runCommand(() => onChangeMode('http'))}
                    className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                  >
                    <FileJson className="mr-2 h-4 w-4" />
                    <span>Switch to HTTP/REST</span>
                  </Command.Item>
                  <Command.Item
                    onSelect={() => runCommand(() => onChangeMode('grpc'))}
                    className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                  >
                    <Server className="mr-2 h-4 w-4" />
                    <span>Switch to gRPC</span>
                  </Command.Item>
                  <Command.Item
                    onSelect={() => runCommand(() => onChangeMode('websocket'))}
                    className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                  >
                    <Wifi className="mr-2 h-4 w-4" />
                    <span>Switch to WebSocket</span>
                  </Command.Item>
                </>
              )}
            </Command.Group>

            <Separator className="my-2 bg-slate-blue-500/10" />

            <Command.Group heading="Settings">
              <Command.Item
                onSelect={() => runCommand(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
                className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
              >
                {theme === 'dark' ? (
                  <Sun className="mr-2 h-4 w-4" />
                ) : (
                  <Moon className="mr-2 h-4 w-4" />
                )}
                <span>Toggle Theme</span>
              </Command.Item>
              {onOpenSettings && (
                <Command.Item
                  onSelect={() => runCommand(onOpenSettings)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                >
                  <Settings2 className="mr-2 h-4 w-4" />
                  <span>Open Settings</span>
                  <kbd className="ml-auto text-xs tracking-widest bg-muted px-1.5 py-0.5 rounded text-muted-foreground">⌘,</kbd>
                </Command.Item>
              )}
              {onOpenEnvironments && (
                <Command.Item
                  onSelect={() => runCommand(onOpenEnvironments)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                >
                  <Globe className="mr-2 h-4 w-4" />
                  <span>Manage Environments</span>
                </Command.Item>
              )}
              {onOpenImport && (
                <Command.Item
                  onSelect={() => runCommand(onOpenImport)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
                >
                  <FolderOpen className="mr-2 h-4 w-4" />
                  <span>Import Collection</span>
                </Command.Item>
              )}
            </Command.Group>

            <Separator className="my-2 bg-slate-blue-500/10" />

            <Command.Group heading="History">
              <Command.Item
                onSelect={() => runCommand(clearHistory)}
                className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-slate-blue-500/10 aria-selected:text-slate-blue-600 dark:aria-selected:text-slate-blue-400 transition-colors"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Clear History</span>
              </Command.Item>
            </Command.Group>
          </Command.List>

          {/* Keyboard shortcuts footer */}
          <div className="flex items-center justify-between border-t border-slate-blue-500/20 px-3 py-2 text-xs text-muted-foreground bg-gradient-to-r from-slate-blue-500/5 to-indigo-500/5">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1">
                <kbd className="bg-muted px-1.5 py-0.5 rounded text-[10px]">↑↓</kbd>
                <span>Navigate</span>
              </div>
              <div className="flex items-center gap-1">
                <kbd className="bg-muted px-1.5 py-0.5 rounded text-[10px]">↵</kbd>
                <span>Select</span>
              </div>
              <div className="flex items-center gap-1">
                <kbd className="bg-muted px-1.5 py-0.5 rounded text-[10px]">Esc</kbd>
                <span>Close</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Keyboard className="h-3 w-3" />
              <span>Command Palette</span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
