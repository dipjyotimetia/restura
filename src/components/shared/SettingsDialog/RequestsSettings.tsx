import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AppSettings } from '@/types';

interface RequestsSettingsProps {
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

export function RequestsSettings({ settings, onChange }: RequestsSettingsProps) {
  return (
    <div className="space-y-4">
      <SectionHeader>Default Request Settings</SectionHeader>

      <div className="space-y-1.5">
        <Label htmlFor="default-timeout" className="text-xs font-mono">Default Timeout</Label>
        <div className="flex items-center gap-2">
          <Input
            id="default-timeout"
            type="number"
            value={settings.defaultTimeout}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              if (value >= 1000 && value <= 600000) onChange({ defaultTimeout: value });
            }}
            min={1000}
            max={600000}
            step={1000}
            className="w-32 font-mono text-xs"
            aria-describedby="timeout-desc"
          />
          <span className="text-xs text-muted-foreground font-mono">ms</span>
        </div>
        <p id="timeout-desc" className="text-xs text-muted-foreground font-mono">
          Current: {(settings.defaultTimeout / 1000).toFixed(0)}s (1–600s)
        </p>
      </div>

      <div className="flex items-center justify-between py-1">
        <div>
          <Label htmlFor="follow-redirects" className="text-xs font-mono">Follow Redirects</Label>
          <p id="follow-redirects-desc" className="text-xs text-muted-foreground mt-0.5">
            Automatically follow HTTP redirects
          </p>
        </div>
        <Switch
          id="follow-redirects"
          checked={settings.followRedirects}
          onCheckedChange={(followRedirects) => onChange({ followRedirects })}
          aria-describedby="follow-redirects-desc"
        />
      </div>

      {settings.followRedirects && (
        <div className="space-y-1.5">
          <Label htmlFor="max-redirects" className="text-xs font-mono">Max Redirects</Label>
          <Input
            id="max-redirects"
            type="number"
            value={settings.maxRedirects}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              if (value >= 1 && value <= 50) onChange({ maxRedirects: value });
            }}
            min={1}
            max={50}
            className="w-24 font-mono text-xs"
            aria-describedby="max-redirects-desc"
          />
          <p id="max-redirects-desc" className="text-xs text-muted-foreground font-mono">1–50 redirects</p>
        </div>
      )}
    </div>
  );
}
