import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSettingsStore } from '@/store/useSettingsStore';
import ProxySettings from './ProxySettings';
import { Settings2, Network, Clock, Shield, RotateCcw, Sun, Moon, Monitor, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

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

  const handleSettingChange = <K extends keyof typeof settings>(updates: Pick<typeof settings, K>) => {
    updateSettings(updates);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-hidden flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
          <SheetTitle className="flex items-center gap-2 font-mono text-sm tracking-wide">
            <Settings2 className="h-4 w-4 text-primary" />
            SETTINGS
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar nav */}
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

          {/* Content area */}
          <div className="flex-1 overflow-auto px-6 py-5">
            {activeSection === 'general' && (
              <div className="space-y-6">
                <div>
                  <SectionHeader>Appearance</SectionHeader>
                  <div className="space-y-2">
                    <Label htmlFor="theme-select" className="text-xs font-mono">Theme</Label>
                    <Select
                      value={settings.theme}
                      onValueChange={(value: 'light' | 'dark' | 'system') => handleSettingChange({ theme: value })}
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
                        onCheckedChange={(autoSaveHistory) => handleSettingChange({ autoSaveHistory })}
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
                          if (value >= 10 && value <= 1000) {
                            handleSettingChange({ maxHistoryItems: value });
                          }
                        }}
                        min={10}
                        max={1000}
                        className="w-28 font-mono text-xs"
                        aria-describedby="max-history-desc"
                      />
                      <p id="max-history-desc" className="text-xs text-muted-foreground font-mono">
                        10–1000 requests
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'proxy' && (
              <div>
                <SectionHeader>Proxy</SectionHeader>
                <ProxySettings />
              </div>
            )}

            {activeSection === 'requests' && (
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
                        if (value >= 1000 && value <= 600000) {
                          handleSettingChange({ defaultTimeout: value });
                        }
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
                    onCheckedChange={(followRedirects) => handleSettingChange({ followRedirects })}
                    aria-describedby="follow-redirects-desc"
                  />
                </div>

                {settings.followRedirects && (
                  <div className="space-y-1.5 pl-0">
                    <Label htmlFor="max-redirects" className="text-xs font-mono">Max Redirects</Label>
                    <Input
                      id="max-redirects"
                      type="number"
                      value={settings.maxRedirects}
                      onChange={(e) => {
                        const value = parseInt(e.target.value);
                        if (value >= 1 && value <= 50) {
                          handleSettingChange({ maxRedirects: value });
                        }
                      }}
                      min={1}
                      max={50}
                      className="w-24 font-mono text-xs"
                      aria-describedby="max-redirects-desc"
                    />
                    <p id="max-redirects-desc" className="text-xs text-muted-foreground font-mono">
                      1–50 redirects
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeSection === 'security' && (
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
                      onCheckedChange={(verifySsl) => handleSettingChange({ verifySsl })}
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
                      onCheckedChange={(allowLocalhost) => handleSettingChange({ allowLocalhost })}
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
                      onCheckedChange={(allowPrivateIPs) => handleSettingChange({ allowPrivateIPs })}
                      aria-describedby="allow-private-desc"
                    />
                  </div>
                </div>
              </div>
            )}
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
