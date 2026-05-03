import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sun, Moon, Monitor } from 'lucide-react';
import type { AppSettings } from '@/types';

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: (updates: Partial<AppSettings>) => void;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
      {children}
    </p>
  );
}

export function GeneralSettings({ settings, onChange }: GeneralSettingsProps) {
  return (
    <div className="space-y-6">
      <div>
        <SectionHeader>Appearance</SectionHeader>
        <div className="space-y-2">
          <Label htmlFor="theme-select" className="text-xs font-mono">Theme</Label>
          <Select
            value={settings.theme}
            onValueChange={(value: 'light' | 'dark' | 'system') => onChange({ theme: value })}
          >
            <SelectTrigger id="theme-select" className="w-48 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light" className="font-mono text-xs">
                <span className="flex items-center gap-2"><Sun className="h-3.5 w-3.5" /> Light</span>
              </SelectItem>
              <SelectItem value="dark" className="font-mono text-xs">
                <span className="flex items-center gap-2"><Moon className="h-3.5 w-3.5" /> Dark</span>
              </SelectItem>
              <SelectItem value="system" className="font-mono text-xs">
                <span className="flex items-center gap-2"><Monitor className="h-3.5 w-3.5" /> System</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <SectionHeader>History</SectionHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-1">
            <div>
              <Label htmlFor="auto-save-switch" className="text-xs font-mono">Auto-save History</Label>
              <p id="auto-save-desc" className="text-xs text-muted-foreground mt-0.5">
                Automatically save requests to history
              </p>
            </div>
            <Switch
              id="auto-save-switch"
              checked={settings.autoSaveHistory}
              onCheckedChange={(autoSaveHistory) => onChange({ autoSaveHistory })}
              aria-describedby="auto-save-desc"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="max-history" className="text-xs font-mono">Max History Items</Label>
            <Input
              id="max-history"
              type="number"
              value={settings.maxHistoryItems}
              onChange={(e) => {
                const value = parseInt(e.target.value);
                if (value >= 10 && value <= 1000) onChange({ maxHistoryItems: value });
              }}
              min={10}
              max={1000}
              className="w-28 font-mono text-xs"
              aria-describedby="max-history-desc"
            />
            <p id="max-history-desc" className="text-xs text-muted-foreground font-mono">10–1000 requests</p>
          </div>
        </div>
      </div>
    </div>
  );
}
