import { useState, useEffect } from 'react';
import { FolderOpen, History, GitBranch, Settings2, Sun, Moon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';
import { motion } from '@/components/ui/motion';
import type { ActivePanel } from '@/types';

interface IconRailProps {
  activePanel: ActivePanel | null;
  onPanelChange: (panel: ActivePanel) => void;
  onOpenSettings: () => void;
}

const NAV_ITEMS = [
  { id: 'collections' as const, icon: FolderOpen, label: 'Collections' },
  { id: 'history' as const, icon: History, label: 'History' },
  { id: 'workflows' as const, icon: GitBranch, label: 'Workflows' },
];

export default function IconRail({
  activePanel,
  onPanelChange,
  onOpenSettings,
}: IconRailProps) {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme, resolvedTheme } = useTheme();

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

  const isDark = mounted && (theme === 'dark' || resolvedTheme === 'dark');

  return (
    <TooltipProvider delayDuration={400}>
      <nav aria-label="Primary" className="flex flex-col h-full w-12 glass-1 glass-border-default border-r items-center py-3 gap-1 select-none shrink-0">
        {/* Logo */}
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/20 border border-primary/30 mb-2">
          <span className="text-primary font-bold text-base font-mono">R</span>
        </div>

        {/* Separator */}
        <div className="w-5 h-px bg-border mb-1" />

        {/* Nav icons */}
        <div className="flex flex-col flex-1 items-center gap-1">
          {NAV_ITEMS.map(({ id, icon: Icon, label }) => {
            const isActive = activePanel === id;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onPanelChange(id)}
                    aria-label={label}
                    aria-pressed={isActive}
                    className={cn(
                      'w-9 h-9 rounded-md flex items-center justify-center transition-all duration-150',
                      isActive
                        ? 'bg-primary/15 text-primary relative'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="rail-indicator"
                        className="absolute left-[-3px] top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r"
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                      />
                    )}
                    <Icon className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Bottom: Settings + Theme */}
        <div className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                aria-label="Settings"
                className="w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150 flex items-center justify-center"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Settings (⌘,)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleTheme}
                aria-label="Toggle theme"
                className="w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150 flex items-center justify-center"
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Toggle Theme</TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
