'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettingsStore } from '@/store/useSettingsStore';
import ProxySettings from './ProxySettings';
import { Settings2, Network, Clock, Shield, RotateCcw, Sun, Moon, Monitor } from 'lucide-react';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('general');

  const handleSettingChange = <K extends keyof typeof settings>(updates: Pick<typeof settings, K>) => {
    updateSettings(updates);
  };

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
              {/* Theme Settings */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Appearance</h3>

                <div className="space-y-2">
                  <Label htmlFor="theme-select">Theme</Label>
                  <Select
                    value={settings.theme}
                    onValueChange={(value: 'light' | 'dark' | 'system') => handleSettingChange({ theme: value })}
                  >
                    <SelectTrigger id="theme-select" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">
                        <span className="flex items-center gap-2">
                          <Sun className="h-4 w-4" /> Light
                        </span>
                      </SelectItem>
                      <SelectItem value="dark">
                        <span className="flex items-center gap-2">
                          <Moon className="h-4 w-4" /> Dark
                        </span>
                      </SelectItem>
                      <SelectItem value="system">
                        <span className="flex items-center gap-2">
                          <Monitor className="h-4 w-4" /> System
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* History Settings */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">History</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="auto-save-switch">Auto-save History</Label>
                    <p id="auto-save-desc" className="text-sm text-muted-foreground">
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

                <div className="space-y-2">
                  <Label htmlFor="max-history">Max History Items</Label>
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
                    className="w-32"
                    aria-describedby="max-history-desc"
                  />
                  <p id="max-history-desc" className="text-xs text-muted-foreground">
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
                  <Label htmlFor="default-timeout">Default Timeout (ms)</Label>
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
                    className="w-48"
                    aria-describedby="timeout-desc"
                  />
                  <p id="timeout-desc" className="text-xs text-muted-foreground">
                    Request timeout in milliseconds (1000-600000). Current: {(settings.defaultTimeout / 1000).toFixed(0)}s
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="follow-redirects">Follow Redirects</Label>
                    <p id="follow-redirects-desc" className="text-sm text-muted-foreground">
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

                <AnimatePresence>
                  {settings.followRedirects && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-2 overflow-hidden"
                    >
                      <Label htmlFor="max-redirects">Max Redirects</Label>
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
                        className="w-32"
                        aria-describedby="max-redirects-desc"
                      />
                      <p id="max-redirects-desc" className="text-xs text-muted-foreground">
                        Maximum number of redirects to follow (1-50)
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </TabsContent>

            <TabsContent value="security" className="m-0 space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">SSL/TLS Settings</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="verify-ssl">Verify SSL Certificates</Label>
                    <p id="verify-ssl-desc" className="text-sm text-muted-foreground">
                      Validate SSL/TLS certificates for HTTPS requests
                    </p>
                  </div>
                  <Switch
                    id="verify-ssl"
                    checked={settings.verifySsl}
                    onCheckedChange={(verifySsl) => handleSettingChange({ verifySsl })}
                    aria-describedby="verify-ssl-desc ssl-warning"
                  />
                </div>

                <AnimatePresence>
                  {!settings.verifySsl && (
                    <motion.div
                      id="ssl-warning"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-4 overflow-hidden"
                      role="alert"
                    >
                      <p className="text-sm text-yellow-600 dark:text-yellow-400">
                        <strong>Warning:</strong> Disabling SSL verification makes your requests
                        vulnerable to man-in-the-middle attacks. Only disable for development or
                        testing purposes.
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Network Security</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="allow-localhost">Allow Localhost</Label>
                    <p id="allow-localhost-desc" className="text-sm text-muted-foreground">
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

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="allow-private-ips">Allow Private IPs</Label>
                    <p id="allow-private-desc" className="text-sm text-muted-foreground">
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
            </TabsContent>
          </div>
        </Tabs>

        <div className="flex justify-between pt-4 border-t mt-auto">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4" />
                Reset to Defaults
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
                <AlertDialogAction onClick={resetSettings}>
                  Reset Settings
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
