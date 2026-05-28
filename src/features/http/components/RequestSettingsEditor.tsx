'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MinTlsVersion, RequestSettings, GlobalSettings } from '@/types';
import { CertificateOverride } from './CertificateOverride';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { cn } from '@/lib/shared/utils';

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
  const [tlsAdvancedOpen, setTlsAdvancedOpen] = useState(false);

  const getEffectiveSettings = (): RequestSettings => {
    return (
      settings || {
        timeout: globalSettings.defaultTimeout,
        followRedirects: globalSettings.followRedirects,
        maxRedirects: globalSettings.maxRedirects,
        verifySsl: globalSettings.verifySsl,
        proxy: globalSettings.proxy,
        ...(globalSettings.followOriginalMethod !== undefined && {
          followOriginalMethod: globalSettings.followOriginalMethod,
        }),
        ...(globalSettings.followAuthHeader !== undefined && {
          followAuthHeader: globalSettings.followAuthHeader,
        }),
        ...(globalSettings.stripReferer !== undefined && {
          stripReferer: globalSettings.stripReferer,
        }),
        ...(globalSettings.encodeUrlAutomatically !== undefined && {
          encodeUrlAutomatically: globalSettings.encodeUrlAutomatically,
        }),
        ...(globalSettings.disableCookieJar !== undefined && {
          disableCookieJar: globalSettings.disableCookieJar,
        }),
        ...(globalSettings.serverCipherOrder !== undefined && {
          serverCipherOrder: globalSettings.serverCipherOrder,
        }),
        ...(globalSettings.minTlsVersion !== undefined && {
          minTlsVersion: globalSettings.minTlsVersion,
        }),
        ...(globalSettings.cipherSuites !== undefined && {
          cipherSuites: globalSettings.cipherSuites,
        }),
      }
    );
  };

  const handleCertOverrideToggle = (enabled: boolean) => {
    if (!enabled) {
      // EOPT(maintainability): callers interpret an explicit `undefined` as a
      // "clear this key" signal — Partial<T> doesn't model that under EOPT.
      // Cast to unknown then back so the intent is preserved without widening
      // the public type.
      onSettingsChange({ clientCert: undefined } as unknown as Partial<RequestSettings>);
    } else {
      onSettingsChange({ clientCert: { format: settings?.clientCert?.format ?? 'pfx' } });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 rounded-sp-panel border border-sp-line bg-sp-surface-lo/60 px-4 py-3">
        <div className="space-y-0.5">
          <Label className="text-base font-medium">Override global settings</Label>
          <p className="text-sm text-muted-foreground">
            {settings
              ? 'This request uses custom settings below.'
              : 'Currently following the workspace defaults.'}
          </p>
        </div>
        <Switch
          checked={!!settings}
          onCheckedChange={onToggleOverride}
          aria-label="Toggle settings override"
        />
      </div>

      {settings ? (
        <>
          <section className="space-y-4">
            <h3 className="sp-label">Request</h3>

            {/* Timeout */}
            <div className="space-y-2">
              <Label htmlFor="timeout">Request timeout</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="timeout"
                  type="number"
                  value={getEffectiveSettings().timeout}
                  onChange={(e) => onSettingsChange({ timeout: parseInt(e.target.value) || 30000 })}
                  min={1000}
                  max={600000}
                  step={1000}
                  className="w-40 bg-background border-border"
                />
                <span className="text-xs text-muted-foreground">
                  ms · ~{(getEffectiveSettings().timeout / 1000).toFixed(0)}s
                </span>
              </div>
            </div>

            {/* Follow Redirects */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Follow redirects</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically follow HTTP 3xx redirects
                </p>
              </div>
              <Switch
                checked={getEffectiveSettings().followRedirects}
                onCheckedChange={(followRedirects) => onSettingsChange({ followRedirects })}
                aria-label="Toggle follow redirects"
              />
            </div>

            {getEffectiveSettings().followRedirects && (
              <div className="space-y-4 pl-4 border-l-2 border-sp-line">
                <div className="space-y-2">
                  <Label htmlFor="maxRedirects">Max redirects</Label>
                  <Input
                    id="maxRedirects"
                    type="number"
                    value={getEffectiveSettings().maxRedirects}
                    onChange={(e) =>
                      onSettingsChange({ maxRedirects: parseInt(e.target.value) || 10 })
                    }
                    min={1}
                    max={50}
                    className="w-28 bg-background border-border"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Follow original HTTP method</Label>
                    <p className="text-sm text-muted-foreground">
                      RFC-compliant: don&apos;t downgrade 301 / 302 to GET.
                    </p>
                  </div>
                  <Switch
                    checked={getEffectiveSettings().followOriginalMethod === true}
                    onCheckedChange={(followOriginalMethod) =>
                      onSettingsChange({ followOriginalMethod })
                    }
                    aria-label="Toggle follow original method on redirect"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Follow Authorization header</Label>
                    <p className="text-sm text-muted-foreground">
                      Keep Authorization on cross-origin redirects. Default off.
                    </p>
                  </div>
                  <Switch
                    checked={getEffectiveSettings().followAuthHeader === true}
                    onCheckedChange={(followAuthHeader) => onSettingsChange({ followAuthHeader })}
                    aria-label="Toggle follow Authorization across hostnames"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Remove Referer on redirect</Label>
                    <p className="text-sm text-muted-foreground">
                      Strip the Referer header on every hop.
                    </p>
                  </div>
                  <Switch
                    checked={getEffectiveSettings().stripReferer === true}
                    onCheckedChange={(stripReferer) => onSettingsChange({ stripReferer })}
                    aria-label="Toggle strip Referer on redirect"
                  />
                </div>
              </div>
            )}

            {/* Encode URL automatically — standalone (default ON) */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Encode URL automatically</Label>
                <p className="text-sm text-muted-foreground">
                  Percent-encode path &amp; query. Disable when the upstream rejects encoded special
                  chars.
                </p>
              </div>
              <Switch
                checked={getEffectiveSettings().encodeUrlAutomatically !== false}
                onCheckedChange={(encodeUrlAutomatically) =>
                  onSettingsChange({ encodeUrlAutomatically })
                }
                aria-label="Toggle automatic URL encoding"
              />
            </div>
          </section>

          <div className="h-px bg-sp-line" />

          <section className="space-y-4">
            <h3 className="sp-label">Security</h3>

            {/* SSL Verification */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center">
                  <Label>Verify SSL certificates</Label>
                  <DesktopOnlyBadge title="Browsers always validate TLS — this toggle has no effect in the web client. The Electron desktop app honours it for self-signed / dev certificates." />
                </div>
                <p className="text-sm text-muted-foreground">Validate SSL/TLS certificates</p>
              </div>
              <Switch
                checked={getEffectiveSettings().verifySsl}
                onCheckedChange={(verifySsl) => onSettingsChange({ verifySsl })}
                aria-label="Toggle SSL verification"
              />
            </div>

            {/* Server cipher order (desktop-only) */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center">
                  <Label>Use server cipher suite order</Label>
                  <DesktopOnlyBadge title="Browsers/Workers can't influence TLS handshake parameters from JS. Desktop only." />
                </div>
                <p className="text-sm text-muted-foreground">
                  Honour the server&apos;s cipher preference order during handshake.
                </p>
              </div>
              <Switch
                checked={getEffectiveSettings().serverCipherOrder === true}
                onCheckedChange={(serverCipherOrder) => onSettingsChange({ serverCipherOrder })}
                aria-label="Toggle server cipher order"
              />
            </div>

            {/* Advanced TLS disclosure */}
            <button
              type="button"
              onClick={() => setTlsAdvancedOpen((v) => !v)}
              aria-expanded={tlsAdvancedOpen}
              className="flex items-center gap-1.5 text-sp-12 text-sp-muted hover:text-sp-text transition-colors"
            >
              <ChevronDown
                size={14}
                className={cn('transition-transform', tlsAdvancedOpen && 'rotate-180')}
              />
              <span>TLS advanced</span>
            </button>

            {tlsAdvancedOpen && (
              <div className="space-y-4 pl-4 border-l-2 border-sp-line">
                <div className="space-y-2">
                  <div className="flex items-center">
                    <Label htmlFor="minTlsVersion">Minimum TLS version</Label>
                    <DesktopOnlyBadge title="Web client uses the runtime's TLS floor. Desktop only." />
                  </div>
                  <Select
                    value={getEffectiveSettings().minTlsVersion ?? 'default'}
                    onValueChange={(value) => {
                      if (value === 'default') {
                        onSettingsChange({
                          minTlsVersion: undefined,
                        } as unknown as Partial<RequestSettings>);
                      } else {
                        onSettingsChange({ minTlsVersion: value as MinTlsVersion });
                      }
                    }}
                  >
                    <SelectTrigger id="minTlsVersion" className="w-56 bg-background border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default (use Node default)</SelectItem>
                      <SelectItem value="TLSv1">TLSv1.0</SelectItem>
                      <SelectItem value="TLSv1.1">TLSv1.1</SelectItem>
                      <SelectItem value="TLSv1.2">TLSv1.2</SelectItem>
                      <SelectItem value="TLSv1.3">TLSv1.3</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Reject handshakes below this protocol version.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center">
                    <Label htmlFor="cipherSuites">Cipher suites</Label>
                    <DesktopOnlyBadge title="Cipher suite control requires direct TLS handshake control. Desktop only." />
                  </div>
                  <Input
                    id="cipherSuites"
                    value={getEffectiveSettings().cipherSuites ?? ''}
                    onChange={(e) => onSettingsChange({ cipherSuites: e.target.value })}
                    placeholder="ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384"
                    className="font-mono bg-background border-border"
                  />
                  <p className="text-xs text-muted-foreground">
                    OpenSSL-format colon-separated list. Leave blank for default.
                  </p>
                </div>
              </div>
            )}
          </section>

          <div className="h-px bg-sp-line" />

          <section className="space-y-4">
            <h3 className="sp-label">Network</h3>

            {/* Disable cookie jar */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Disable cookie jar</Label>
                <p className="text-sm text-muted-foreground">
                  Skip the shared cookie store for this request — no Cookie header is added and
                  Set-Cookie responses are not stored.
                </p>
              </div>
              <Switch
                checked={getEffectiveSettings().disableCookieJar === true}
                onCheckedChange={(disableCookieJar) => onSettingsChange({ disableCookieJar })}
                aria-label="Toggle disable cookie jar"
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
                    <Label className="text-base font-medium">
                      Client Certificate for this Request
                    </Label>
                    <DesktopOnlyBadge title="Browsers don't allow JavaScript to present a client certificate. mTLS is only enforced in the Electron desktop app." />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Use a custom client certificate (mTLS)
                  </p>
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
                  onCertChange={(cert) =>
                    // EOPT(maintainability): cert can be undefined to clear the
                    // override; Partial<T> can't model that under EOPT, so we
                    // assert through unknown to preserve the existing contract.
                    onSettingsChange({ clientCert: cert } as Partial<RequestSettings>)
                  }
                />
              )}
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-sp-panel border border-sp-line bg-sp-surface-lo/40 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="sp-label">Workspace defaults</p>
            <p className="text-sp-11 text-sp-dim">Toggle override above to customize</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center justify-between border-b border-sp-line pb-1.5">
              <dt className="text-muted-foreground">Timeout</dt>
              <dd className="font-mono text-sp-text/90">
                {(globalSettings.defaultTimeout / 1000).toFixed(0)}s
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-sp-line pb-1.5">
              <dt className="text-muted-foreground">Follow redirects</dt>
              <dd className="font-mono text-sp-text/90">
                {globalSettings.followRedirects ? 'Yes' : 'No'}
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-sp-line pb-1.5">
              <dt className="text-muted-foreground">Verify SSL</dt>
              <dd className="font-mono text-sp-text/90">
                {globalSettings.verifySsl ? 'Yes' : 'No'}
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-sp-line pb-1.5">
              <dt className="text-muted-foreground">Proxy</dt>
              <dd className="font-mono text-sp-text/90 truncate ml-2">
                {globalSettings.proxy.enabled
                  ? `${globalSettings.proxy.type}://${globalSettings.proxy.host}:${globalSettings.proxy.port}`
                  : 'Disabled'}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
