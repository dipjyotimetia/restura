'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Keyboard } from 'lucide-react';

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open command palette' },
      { keys: ['⌘', '/'], description: 'Show keyboard shortcuts' },
      { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
      { keys: ['⌘', ','], description: 'Open settings' },
      { keys: ['⌘', 'N'], description: 'New request' },
    ],
  },
  {
    title: 'Request Builder',
    shortcuts: [
      { keys: ['⌘', '↵'], description: 'Send request' },
      { keys: ['⌥', '1'], description: 'Switch to Params tab' },
      { keys: ['⌥', '2'], description: 'Switch to Headers tab' },
      { keys: ['⌥', '3'], description: 'Switch to Body tab' },
      { keys: ['⌥', '4'], description: 'Switch to Auth tab' },
      { keys: ['⌥', '5'], description: 'Switch to Scripts tab' },
      { keys: ['⌥', '6'], description: 'Switch to Settings tab' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['⌘', '1'], description: 'HTTP mode' },
      { keys: ['⌘', '2'], description: 'gRPC mode' },
      { keys: ['⌘', '3'], description: 'WebSocket mode' },
      { keys: ['⌘', 'I'], description: 'Import collection' },
      { keys: ['⌘', 'E'], description: 'Export collection' },
    ],
  },
  {
    title: 'Response',
    shortcuts: [
      { keys: ['⌘', 'C'], description: 'Copy response body' },
      { keys: ['⌘', 'S'], description: 'Save response to file' },
    ],
  },
];

export default function KeyboardShortcutsPanel() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + / to show shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setIsOpen(true);
      }
      // Escape to close
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-2xl glass">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-slate-blue-500" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 py-4">
          {shortcutGroups.map((group) => (
            <div key={group.title} className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-blue-600 dark:text-slate-blue-400">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, keyIdx) => (
                        <kbd
                          key={keyIdx}
                          className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 font-mono text-xs font-medium"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
          <p className="text-xs text-muted-foreground text-center">
            Press <kbd className="mx-1 inline-flex h-4 items-center rounded border bg-muted px-1 font-mono text-[10px]">Esc</kbd> to close
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
