import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle } from 'lucide-react';
import type { AppSettings } from '@/types';

interface SecuritySettingsProps {
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

export function SecuritySettings({ settings, onChange }: SecuritySettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SectionHeader>SSL / TLS</SectionHeader>

        <div className="flex items-center justify-between py-1">
          <div>
            <Label htmlFor="verify-ssl" className="text-xs font-mono">Verify SSL Certificates</Label>
            <p id="verify-ssl-desc" className="text-xs text-muted-foreground mt-0.5">
              Validate SSL/TLS certificates for HTTPS requests
            </p>
          </div>
          <Switch
            id="verify-ssl"
            checked={settings.verifySsl}
            onCheckedChange={(verifySsl) => onChange({ verifySsl })}
            aria-describedby="verify-ssl-desc"
          />
        </div>

        {!settings.verifySsl && (
          <div
            id="ssl-warning"
            className="flex items-start gap-2 rounded bg-amber-500/10 border border-amber-500/20 p-3"
            role="alert"
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-400 font-mono">
              Disabling SSL verification makes requests vulnerable to MITM attacks. Use only for development.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <SectionHeader>Network Security</SectionHeader>

        <div className="flex items-center justify-between py-1">
          <div>
            <Label htmlFor="allow-localhost" className="text-xs font-mono">Allow Localhost</Label>
            <p id="allow-localhost-desc" className="text-xs text-muted-foreground mt-0.5">
              Allow requests to localhost and 127.0.0.1
            </p>
          </div>
          <Switch
            id="allow-localhost"
            checked={settings.allowLocalhost}
            onCheckedChange={(allowLocalhost) => onChange({ allowLocalhost })}
            aria-describedby="allow-localhost-desc"
          />
        </div>

        <div className="flex items-center justify-between py-1">
          <div>
            <Label htmlFor="allow-private-ips" className="text-xs font-mono">Allow Private IPs</Label>
            <p id="allow-private-desc" className="text-xs text-muted-foreground mt-0.5">
              Allow requests to private IP ranges (192.168.x.x, 10.x.x.x, etc.)
            </p>
          </div>
          <Switch
            id="allow-private-ips"
            checked={settings.allowPrivateIPs}
            onCheckedChange={(allowPrivateIPs) => onChange({ allowPrivateIPs })}
            aria-describedby="allow-private-desc"
          />
        </div>
      </div>
    </div>
  );
}
