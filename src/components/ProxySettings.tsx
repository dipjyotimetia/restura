'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ProxyType } from '@/types';
import { Plus, Trash2, Shield, Globe, Zap, Eye, EyeOff } from 'lucide-react';
import { isWeb } from '@/lib/platform';

export default function ProxySettings() {
  const { settings, updateProxy, setProxyAuth, clearProxyAuth, addBypassHost, removeBypassHost, setCorsProxyEnabled } = useSettingsStore();
  const { proxy, corsProxy } = settings;

  const [showPassword, setShowPassword] = useState(false);
  const [newBypassHost, setNewBypassHost] = useState('');
  const [inBrowser, setInBrowser] = useState(false);

  useEffect(() => {
    setInBrowser(isWeb());
  }, []);

  const handleAddBypassHost = () => {
    if (newBypassHost.trim()) {
      addBypassHost(newBypassHost.trim());
      setNewBypassHost('');
    }
  };

  return (
    <div className="space-y-6">
      {/* CORS Proxy (Web mode only) */}
      {inBrowser && (
        <div className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <Label htmlFor="cors-proxy-toggle" className="text-base font-medium">CORS Bypass Proxy</Label>
              <Badge variant="secondary" className="text-xs">Web Only</Badge>
            </div>
            <Button
              id="cors-proxy-toggle"
              variant={corsProxy?.enabled ? "default" : "outline"}
              size="sm"
              onClick={() => setCorsProxyEnabled(!corsProxy?.enabled)}
              aria-pressed={corsProxy?.enabled}
              aria-describedby="cors-proxy-desc"
            >
              {corsProxy?.enabled ? "Enabled" : "Disabled"}
            </Button>
          </div>
          <p id="cors-proxy-desc" className="text-sm text-muted-foreground">
            Route browser requests through the server to bypass CORS restrictions.
            This is required for most external API calls in browser mode.
          </p>
        </div>
      )}

      {/* Enable Proxy */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="enable-proxy" className="text-base font-medium">Enable Proxy</Label>
          <p id="enable-proxy-desc" className="text-sm text-muted-foreground">
            Route requests through a proxy server
          </p>
        </div>
        <Switch
          id="enable-proxy"
          checked={proxy.enabled}
          onCheckedChange={(enabled) => updateProxy({ enabled })}
          aria-describedby="enable-proxy-desc"
        />
      </div>

      <AnimatePresence>
        {proxy.enabled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-6 overflow-hidden"
          >
            {/* Proxy URL Preview - Moved to top for better UX */}
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-sm text-muted-foreground">
                <strong>Proxy URL:</strong>{' '}
                {proxy.auth ? (
                  <code className="text-xs">
                    {proxy.type}://{proxy.auth.username}:***@{proxy.host || 'host'}:{proxy.port}
                  </code>
                ) : (
                  <code className="text-xs">
                    {proxy.type}://{proxy.host || 'host'}:{proxy.port}
                  </code>
                )}
              </p>
            </div>

            {/* Proxy Type */}
            <div className="space-y-2">
              <Label htmlFor="proxy-type">Proxy Type</Label>
              <Select
                value={proxy.type}
                onValueChange={(value) => updateProxy({ type: value as ProxyType })}
              >
                <SelectTrigger id="proxy-type">
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
                <Label htmlFor="proxy-host">
                  Proxy Host <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="proxy-host"
                  value={proxy.host}
                  onChange={(e) => updateProxy({ host: e.target.value })}
                  placeholder="proxy.example.com"
                  aria-required="true"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy-port">
                  Port <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="proxy-port"
                  type="number"
                  value={proxy.port}
                  onChange={(e) => {
                    const value = parseInt(e.target.value);
                    if (value >= 1 && value <= 65535) {
                      updateProxy({ port: value });
                    }
                  }}
                  placeholder="8080"
                  min={1}
                  max={65535}
                  aria-required="true"
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
                <Label htmlFor="requires-auth" className="text-sm">Requires Authentication</Label>
                <Switch
                  id="requires-auth"
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

              <AnimatePresence>
                {proxy.auth && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-4 overflow-hidden"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="proxy-username">Username</Label>
                      <Input
                        id="proxy-username"
                        value={proxy.auth.username}
                        onChange={(e) => setProxyAuth(e.target.value, proxy.auth?.password || '')}
                        placeholder="proxy-username"
                        autoComplete="username"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="proxy-password">Password</Label>
                      <div className="relative">
                        <Input
                          id="proxy-password"
                          type={showPassword ? 'text' : 'password'}
                          value={proxy.auth.password}
                          onChange={(e) => setProxyAuth(proxy.auth?.username || '', e.target.value)}
                          placeholder="proxy-password"
                          autoComplete="current-password"
                          className="pr-10"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          type="button"
                          className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Bypass List */}
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary" />
                <Label htmlFor="bypass-host-input" className="text-base font-medium">Bypass List</Label>
              </div>
              <p id="bypass-list-desc" className="text-sm text-muted-foreground">
                Hosts that should bypass the proxy (supports wildcards like *.example.com)
              </p>

              <div className="flex gap-2">
                <Input
                  id="bypass-host-input"
                  value={newBypassHost}
                  onChange={(e) => setNewBypassHost(e.target.value)}
                  placeholder="*.local, 192.168.*"
                  aria-describedby="bypass-list-desc"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddBypassHost();
                    }
                  }}
                />
                <Button
                  onClick={handleAddBypassHost}
                  size="icon"
                  variant="outline"
                  aria-label="Add bypass host"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {(proxy.bypassList || []).length > 0 && (
                <div className="flex flex-wrap gap-2" role="list" aria-label="Bypass hosts">
                  {(proxy.bypassList || []).map((host) => (
                    <Badge key={host} variant="secondary" className="pr-1 gap-1" role="listitem">
                      {host}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 hover:bg-destructive/20 rounded-sm"
                        onClick={() => removeBypassHost(host)}
                        aria-label={`Remove ${host} from bypass list`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
