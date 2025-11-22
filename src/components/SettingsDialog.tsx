'use client';

import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettingsStore } from '@/store/useSettingsStore';
import ProxySettings from './ProxySettings';
import { Settings2, Network, Clock, Shield, RotateCcw } from 'lucide-react';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('general');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            Application Settings
          </SheetTitle>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="general" className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              General
            </TabsTrigger>
            <TabsTrigger value="proxy" className="flex items-center gap-2">
              <Network className="h-4 w-4" />
              Proxy
            </TabsTrigger>
            <TabsTrigger value="requests" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Requests
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Security
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-auto mt-4">
            <TabsContent value="general" className="m-0 space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">History</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Auto-save History</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically save requests to history
                    </p>
                  </div>
                  <Switch
                    checked={settings.autoSaveHistory}
                    onCheckedChange={(autoSaveHistory) => updateSettings({ autoSaveHistory })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Max History Items</Label>
                  <Input
                    type="number"
                    value={settings.maxHistoryItems}
                    onChange={(e) =>
                      updateSettings({ maxHistoryItems: parseInt(e.target.value) || 100 })
                    }
                    min={10}
                    max={1000}
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum number of requests to keep in history (10-1000)
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="proxy" className="m-0">
              <ProxySettings />
            </TabsContent>

            <TabsContent value="requests" className="m-0 space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Default Request Settings</h3>

                <div className="space-y-2">
                  <Label>Default Timeout (ms)</Label>
                  <Input
                    type="number"
                    value={settings.defaultTimeout}
                    onChange={(e) =>
                      updateSettings({ defaultTimeout: parseInt(e.target.value) || 30000 })
                    }
                    min={1000}
                    max={600000}
                    step={1000}
                    className="w-48"
                  />
                  <p className="text-xs text-muted-foreground">
                    Request timeout in milliseconds (1000-600000). Current: {(settings.defaultTimeout / 1000).toFixed(0)}s
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Follow Redirects</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically follow HTTP redirects
                    </p>
                  </div>
                  <Switch
                    checked={settings.followRedirects}
                    onCheckedChange={(followRedirects) => updateSettings({ followRedirects })}
                  />
                </div>

                {settings.followRedirects && (
                  <div className="space-y-2">
                    <Label>Max Redirects</Label>
                    <Input
                      type="number"
                      value={settings.maxRedirects}
                      onChange={(e) =>
                        updateSettings({ maxRedirects: parseInt(e.target.value) || 10 })
                      }
                      min={1}
                      max={50}
                      className="w-32"
                    />
                    <p className="text-xs text-muted-foreground">
                      Maximum number of redirects to follow (1-50)
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="security" className="m-0 space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">SSL/TLS Settings</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Verify SSL Certificates</Label>
                    <p className="text-sm text-muted-foreground">
                      Validate SSL/TLS certificates for HTTPS requests
                    </p>
                  </div>
                  <Switch
                    checked={settings.verifySsl}
                    onCheckedChange={(verifySsl) => updateSettings({ verifySsl })}
                  />
                </div>

                {!settings.verifySsl && (
                  <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-4">
                    <p className="text-sm text-yellow-600 dark:text-yellow-400">
                      <strong>Warning:</strong> Disabling SSL verification makes your requests
                      vulnerable to man-in-the-middle attacks. Only disable for development or
                      testing purposes.
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <div className="flex justify-between pt-4 border-t mt-auto">
          <Button
            variant="outline"
            onClick={() => {
              resetSettings();
            }}
            className="flex items-center gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            Reset to Defaults
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
