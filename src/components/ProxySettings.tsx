'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ProxyType } from '@/types';
import { Plus, Trash2, Shield, Globe } from 'lucide-react';

export default function ProxySettings() {
  const { settings, updateProxy, setProxyAuth, clearProxyAuth, addBypassHost, removeBypassHost } = useSettingsStore();
  const { proxy } = settings;

  const [showPassword, setShowPassword] = useState(false);
  const [newBypassHost, setNewBypassHost] = useState('');

  const handleAddBypassHost = () => {
    if (newBypassHost.trim()) {
      addBypassHost(newBypassHost.trim());
      setNewBypassHost('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Enable Proxy */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-base font-medium">Enable Proxy</Label>
          <p className="text-sm text-muted-foreground">
            Route requests through a proxy server
          </p>
        </div>
        <Switch
          checked={proxy.enabled}
          onCheckedChange={(enabled) => updateProxy({ enabled })}
        />
      </div>

      {proxy.enabled && (
        <>
          {/* Proxy Type */}
          <div className="space-y-2">
            <Label>Proxy Type</Label>
            <Select
              value={proxy.type}
              onValueChange={(value) => updateProxy({ type: value as ProxyType })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="https">HTTPS</SelectItem>
                <SelectItem value="socks4">SOCKS4</SelectItem>
                <SelectItem value="socks5">SOCKS5</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Host and Port */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-2">
              <Label>Proxy Host</Label>
              <Input
                value={proxy.host}
                onChange={(e) => updateProxy({ host: e.target.value })}
                placeholder="proxy.example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Port</Label>
              <Input
                type="number"
                value={proxy.port}
                onChange={(e) => updateProxy({ port: parseInt(e.target.value) || 8080 })}
                placeholder="8080"
                min={1}
                max={65535}
              />
            </div>
          </div>

          {/* Authentication */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <Label className="text-base font-medium">Proxy Authentication</Label>
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-sm">Requires Authentication</Label>
              <Switch
                checked={!!proxy.auth}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setProxyAuth('', '');
                  } else {
                    clearProxyAuth();
                  }
                }}
              />
            </div>

            {proxy.auth && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Username</Label>
                  <Input
                    value={proxy.auth.username}
                    onChange={(e) => setProxyAuth(e.target.value, proxy.auth?.password || '')}
                    placeholder="proxy-username"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Password</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={proxy.auth.password}
                      onChange={(e) => setProxyAuth(proxy.auth?.username || '', e.target.value)}
                      placeholder="proxy-password"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute right-2 top-1/2 -translate-y-1/2 h-6 px-2 text-xs"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bypass List */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              <Label className="text-base font-medium">Bypass List</Label>
            </div>
            <p className="text-sm text-muted-foreground">
              Hosts that should bypass the proxy (supports wildcards like *.example.com)
            </p>

            <div className="flex gap-2">
              <Input
                value={newBypassHost}
                onChange={(e) => setNewBypassHost(e.target.value)}
                placeholder="*.local, 192.168.*"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddBypassHost();
                  }
                }}
              />
              <Button onClick={handleAddBypassHost} size="icon" variant="outline">
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {(proxy.bypassList || []).map((host) => (
                <Badge key={host} variant="secondary" className="pr-1">
                  {host}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 ml-1 hover:bg-destructive/20"
                    onClick={() => removeBypassHost(host)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          </div>

          {/* Connection Test */}
          <div className="rounded-lg bg-muted/50 p-4">
            <p className="text-sm text-muted-foreground">
              <strong>Proxy URL:</strong>{' '}
              {proxy.auth ? (
                <code className="text-xs">
                  {proxy.type}://{proxy.auth.username}:***@{proxy.host}:{proxy.port}
                </code>
              ) : (
                <code className="text-xs">
                  {proxy.type}://{proxy.host}:{proxy.port}
                </code>
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
