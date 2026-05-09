'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { RequestSettings, GlobalSettings } from '@/types';
import { CertificateOverride } from './CertificateOverride';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';

interface RequestSettingsEditorProps {
  settings: RequestSettings | undefined;
  globalSettings: GlobalSettings;
  onSettingsChange: (updates: Partial<RequestSettings>) => void;
  onToggleOverride: (enabled: boolean) => void;
  onProxyOverrideChange: (useOverride: boolean) => void;
}

export default function RequestSettingsEditor({
  settings,
  globalSettings,
  onSettingsChange,
  onToggleOverride,
  onProxyOverrideChange,
}: RequestSettingsEditorProps) {
  const getEffectiveSettings = (): RequestSettings => {
    return settings || {
      timeout: globalSettings.defaultTimeout,
      followRedirects: globalSettings.followRedirects,
      maxRedirects: globalSettings.maxRedirects,
      verifySsl: globalSettings.verifySsl,
      proxy: globalSettings.proxy,
    };
  };

  const handleCertOverrideToggle = (enabled: boolean) => {
    if (!enabled) {
      onSettingsChange({ clientCert: undefined });
    } else {
      onSettingsChange({ clientCert: { format: settings?.clientCert?.format ?? 'pfx' } });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-base font-medium">Override Global Settings</Label>
          <p className="text-sm text-muted-foreground">Customize settings for this specific request</p>
        </div>
        <Switch
          checked={!!settings}
          onCheckedChange={onToggleOverride}
          aria-label="Toggle settings override"
        />
      </div>

      {settings ? (
        <>
          {/* Timeout */}
          <div className="space-y-2">
            <Label htmlFor="timeout">Request Timeout (ms)</Label>
            <Input
              id="timeout"
              type="number"
              value={getEffectiveSettings().timeout}
              onChange={(e) => onSettingsChange({ timeout: parseInt(e.target.value) || 30000 })}
              min={1000}
              max={600000}
              step={1000}
              className="w-48 bg-background border-border"
            />
            <p className="text-xs text-muted-foreground">
              Current: {(getEffectiveSettings().timeout / 1000).toFixed(0)}s
            </p>
          </div>

          {/* Follow Redirects */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Follow Redirects</Label>
              <p className="text-sm text-muted-foreground">Automatically follow HTTP redirects</p>
            </div>
            <Switch
              checked={getEffectiveSettings().followRedirects}
              onCheckedChange={(followRedirects) => onSettingsChange({ followRedirects })}
              aria-label="Toggle follow redirects"
            />
          </div>

          {getEffectiveSettings().followRedirects && (
            <div className="space-y-2 pl-4 border-l-2 border-border">
              <Label htmlFor="maxRedirects">Max Redirects</Label>
              <Input
                id="maxRedirects"
                type="number"
                value={getEffectiveSettings().maxRedirects}
                onChange={(e) => onSettingsChange({ maxRedirects: parseInt(e.target.value) || 10 })}
                min={1}
                max={50}
                className="w-32 bg-background border-border"
              />
            </div>
          )}

          {/* SSL Verification */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center">
                <Label>Verify SSL Certificates</Label>
                <DesktopOnlyBadge
                  title="Browsers always validate TLS — this toggle has no effect in the web client. The Electron desktop app honours it for self-signed / dev certificates."
                />
              </div>
              <p className="text-sm text-muted-foreground">Validate SSL/TLS certificates</p>
            </div>
            <Switch
              checked={getEffectiveSettings().verifySsl}
              onCheckedChange={(verifySsl) => onSettingsChange({ verifySsl })}
              aria-label="Toggle SSL verification"
            />
          </div>

          {/* Proxy Override */}
          <div className="space-y-4 rounded-lg border border-border p-4 bg-background">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base font-medium">Custom Proxy for this Request</Label>
                <p className="text-sm text-muted-foreground">Override global proxy settings</p>
              </div>
              <Switch
                checked={!!settings?.proxy}
                onCheckedChange={onProxyOverrideChange}
                aria-label="Toggle custom proxy"
              />
            </div>

            {settings?.proxy && (
              <div className="space-y-4 mt-4">
                <div className="flex items-center justify-between">
                  <Label>Enable Proxy</Label>
                  <Switch
                    checked={settings.proxy.enabled}
                    onCheckedChange={(enabled) =>
                      onSettingsChange({
                        proxy: { ...settings.proxy!, enabled },
                      })
                    }
                    aria-label="Enable proxy"
                  />
                </div>

                {settings.proxy.enabled && (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="proxyHost">Proxy Host</Label>
                        <Input
                          id="proxyHost"
                          value={settings.proxy.host}
                          onChange={(e) =>
                            onSettingsChange({
                              proxy: { ...settings.proxy!, host: e.target.value },
                            })
                          }
                          placeholder="proxy.example.com"
                          className="bg-background border-border"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxyPort">Port</Label>
                        <Input
                          id="proxyPort"
                          type="number"
                          value={settings.proxy.port}
                          onChange={(e) =>
                            onSettingsChange({
                              proxy: {
                                ...settings.proxy!,
                                port: parseInt(e.target.value) || 8080,
                              },
                            })
                          }
                          placeholder="8080"
                          min={1}
                          max={65535}
                          className="bg-background border-border"
                        />
                      </div>
                    </div>

                    <div className="rounded-lg bg-muted p-3 border border-border">
                      <p className="text-xs text-muted-foreground">
                        <strong>Proxy URL:</strong>{' '}
                        <code className="bg-black/5 dark:bg-white/10 px-1 rounded">
                          {settings.proxy.type}://{settings.proxy.host}:{settings.proxy.port}
                        </code>
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Client Certificate Override */}
          <div className="space-y-4 rounded-lg border border-border p-4 bg-background">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center">
                  <Label className="text-base font-medium">Client Certificate for this Request</Label>
                  <DesktopOnlyBadge
                    title="Browsers don't allow JavaScript to present a client certificate. mTLS is only enforced in the Electron desktop app."
                  />
                </div>
                <p className="text-sm text-muted-foreground">Use a custom client certificate (mTLS)</p>
              </div>
              <Switch
                checked={!!settings?.clientCert}
                onCheckedChange={handleCertOverrideToggle}
                aria-label="Toggle custom client certificate"
              />
            </div>

            {settings?.clientCert && (
              <CertificateOverride
                clientCert={settings.clientCert}
                onCertChange={(cert) => onSettingsChange({ clientCert: cert })}
              />
            )}
          </div>
        </>
      ) : (
        <div className="rounded-lg bg-muted p-4 border border-border">
          <p className="text-sm text-muted-foreground mb-3">
            Using global settings. Enable override above to customize for this request.
          </p>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="font-medium">Timeout:</span>
              <span>{(globalSettings.defaultTimeout / 1000).toFixed(0)}s</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Follow Redirects:</span>
              <span>{globalSettings.followRedirects ? 'Yes' : 'No'}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Verify SSL:</span>
              <span>{globalSettings.verifySsl ? 'Yes' : 'No'}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Proxy:</span>
              <span>
                {globalSettings.proxy.enabled
                  ? `${globalSettings.proxy.type}://${globalSettings.proxy.host}:${globalSettings.proxy.port}`
                  : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
