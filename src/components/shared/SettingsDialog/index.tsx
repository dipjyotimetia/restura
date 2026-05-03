import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Settings2, Network, Clock, Shield, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { AppSettings } from '@/types';
import ProxySettings from '../ProxySettings';
import { GeneralSettings } from './GeneralSettings';
import { RequestsSettings } from './RequestsSettings';
import { SecuritySettings } from './SecuritySettings';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAV_ITEMS = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'proxy', label: 'Proxy', icon: Network },
  { id: 'requests', label: 'Requests', icon: Clock },
  { id: 'security', label: 'Security', icon: Shield },
] as const;

type NavId = typeof NAV_ITEMS[number]['id'];

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
      {children}
    </p>
  );
}

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const [activeSection, setActiveSection] = useState<NavId>('general');

  const handleChange = (updates: Partial<AppSettings>) => updateSettings(updates);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-hidden flex flex-col p-0" aria-describedby={undefined}>
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
          <SheetTitle className="flex items-center gap-2 font-mono text-sm tracking-wide">
            <Settings2 className="h-4 w-4 text-primary" />
            SETTINGS
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-1 overflow-hidden">
          <nav className="w-44 border-r border-border py-3 shrink-0 flex flex-col gap-0.5 px-2">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded text-xs font-mono text-left transition-colors w-full',
                  activeSection === id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-surface-2'
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-auto px-6 py-5">
            {activeSection === 'general' && <GeneralSettings settings={settings} onChange={handleChange} />}
            {activeSection === 'proxy' && (
              <div>
                <SectionHeader>Proxy</SectionHeader>
                <ProxySettings />
              </div>
            )}
            {activeSection === 'requests' && <RequestsSettings settings={settings} onChange={handleChange} />}
            {activeSection === 'security' && <SecuritySettings settings={settings} onChange={handleChange} />}
          </div>
        </div>

        <div className="flex justify-between px-6 py-3 border-t border-border shrink-0">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="font-mono text-xs gap-2">
                <RotateCcw className="h-3.5 w-3.5" />
                Reset Defaults
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all settings?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will reset all settings to their default values. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={resetSettings}>Reset Settings</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" onClick={() => onOpenChange(false)} className="font-mono text-xs">Done</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
