import { Network, Plus, Send, X } from 'lucide-react';
import { useState } from 'react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Badge } from '@/components/ui/badge';
import { Floater, Segmented, Stepper, TextField, ToggleField } from '@/components/ui/spatial';
import SecretInput from '@/features/auth/components/SecretInput';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { MinTlsVersion, ProxyType } from '@/types';
import {
  FieldGroup,
  FieldRow,
  SectionHeader,
  SectionLabel,
} from '../components/SettingsSectionPrimitives';

export function RequestsSection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <>
      <SectionHeader
        icon={Send}
        title="Requests"
        description="Defaults for new requests and execution behavior."
      />
      <FieldGroup label="Timeouts">
        <FieldRow
          label="Default timeout"
          hint="Abort requests that don't respond within this window."
          control={
            <Stepper
              value={Math.round((settings.defaultTimeout ?? 30000) / 1000)}
              onChange={(value) => updateSettings({ defaultTimeout: Math.max(1, value) * 1000 })}
              min={1}
              max={600}
              step={5}
              unit="s"
              ariaLabel="Default timeout in seconds"
            />
          }
        />
      </FieldGroup>
      <FieldGroup label="Redirects & TLS">
        <FieldRow
          label="Follow redirects"
          hint="Automatically follow HTTP 3xx responses."
          control={
            <ToggleField
              checked={settings.followRedirects ?? true}
              onChange={(value) => updateSettings({ followRedirects: value })}
              ariaLabel="Follow redirects"
            />
          }
        />
        {(settings.followRedirects ?? true) && (
          <>
            <FieldRow
              label="Max redirects"
              hint="Hard cap on redirect chain length."
              control={
                <Stepper
                  value={settings.maxRedirects ?? 10}
                  onChange={(value) => updateSettings({ maxRedirects: value })}
                  min={0}
                  max={50}
                  ariaLabel="Max redirects"
                />
              }
            />
            <FieldRow
              label="Follow original HTTP method"
              hint="RFC-compliant: don't downgrade 301 / 302 to GET."
              control={
                <ToggleField
                  checked={settings.followOriginalMethod === true}
                  onChange={(value) => updateSettings({ followOriginalMethod: value })}
                  ariaLabel="Follow original method on redirect"
                />
              }
            />
            <FieldRow
              label="Follow Authorization header"
              hint="Keep Authorization on cross-origin redirects. Default off."
              control={
                <ToggleField
                  checked={settings.followAuthHeader === true}
                  onChange={(value) => updateSettings({ followAuthHeader: value })}
                  ariaLabel="Follow Authorization across hostnames"
                />
              }
            />
            <FieldRow
              label="Remove Referer on redirect"
              hint="Strip the Referer header on every hop."
              control={
                <ToggleField
                  checked={settings.stripReferer === true}
                  onChange={(value) => updateSettings({ stripReferer: value })}
                  ariaLabel="Strip Referer on redirect"
                />
              }
            />
          </>
        )}
        <FieldRow
          label={
            <span className="inline-flex items-center">
              Verify SSL certificates
              <DesktopOnlyBadge title="Browsers and the Worker can't disable TLS verification. This toggle only takes effect in the Restura desktop app." />
            </span>
          }
          hint="Disable only for trusted development hosts."
          control={
            <ToggleField
              checked={settings.verifySsl ?? true}
              onChange={(value) => updateSettings({ verifySsl: value })}
              ariaLabel="Verify SSL"
            />
          }
        />
      </FieldGroup>
      <FieldGroup label="URL &amp; cookies">
        <FieldRow
          label="Encode URL automatically"
          hint="Percent-encode path & query. Disable when the upstream rejects encoded special chars."
          control={
            <ToggleField
              checked={settings.encodeUrlAutomatically !== false}
              onChange={(value) => updateSettings({ encodeUrlAutomatically: value })}
              ariaLabel="Encode URL automatically"
            />
          }
        />
        <FieldRow
          label="Disable cookie jar"
          hint="Skip the shared cookie store — no Cookie header is sent and Set-Cookie responses are not stored."
          control={
            <ToggleField
              checked={settings.disableCookieJar === true}
              onChange={(value) => updateSettings({ disableCookieJar: value })}
              ariaLabel="Disable cookie jar"
            />
          }
        />
      </FieldGroup>
      <section className="mt-5">
        <SectionLabel>
          <span className="inline-flex items-center">
            TLS (advanced)
            <DesktopOnlyBadge title="TLS handshake parameters can't be controlled from a browser/Worker. Desktop only." />
          </span>
        </SectionLabel>
        <Floater radius="panel" elevation="inset" className="px-4 divide-y divide-sp-line">
          <FieldRow
            label="Use server cipher suite order"
            hint="Honour the server's cipher preference order during handshake."
            control={
              <ToggleField
                checked={settings.serverCipherOrder === true}
                onChange={(value) => updateSettings({ serverCipherOrder: value })}
                ariaLabel="Use server cipher order"
              />
            }
          />
          <FieldRow
            label="Minimum TLS version"
            hint="Reject handshakes below this protocol version."
            control={
              <Segmented<'default' | MinTlsVersion>
                value={settings.minTlsVersion ?? 'default'}
                onChange={(value) =>
                  updateSettings(
                    value === 'default'
                      ? ({ minTlsVersion: undefined } as Partial<typeof settings>)
                      : { minTlsVersion: value }
                  )
                }
                size="sm"
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'TLSv1', label: '1.0' },
                  { value: 'TLSv1.1', label: '1.1' },
                  { value: 'TLSv1.2', label: '1.2' },
                  { value: 'TLSv1.3', label: '1.3' },
                ]}
                ariaLabel="Minimum TLS version"
              />
            }
          />
          <FieldRow
            label="Cipher suites"
            hint="OpenSSL-format colon-separated list. Leave blank for default."
            control={
              <TextField
                mono
                placeholder="ECDHE-RSA-AES128-GCM-SHA256"
                value={settings.cipherSuites ?? ''}
                onChange={(event) => updateSettings({ cipherSuites: event.target.value })}
                className="w-[260px]"
              />
            }
          />
        </Floater>
      </section>
      <FieldGroup label="History">
        <FieldRow
          label="Max history items"
          hint="Older entries are evicted once this cap is reached."
          control={
            <Stepper
              value={settings.maxHistoryItems ?? 100}
              onChange={(value) => updateSettings({ maxHistoryItems: value })}
              min={10}
              max={5000}
              step={10}
              ariaLabel="Max history items"
            />
          }
        />
      </FieldGroup>
    </>
  );
}

export function ProxySection() {
  const settings = useSettingsStore((s) => s.settings);
  const setProxyEnabled = useSettingsStore((s) => s.setProxyEnabled);
  const updateProxy = useSettingsStore((s) => s.updateProxy);
  const updateProxyAuth = useSettingsStore((s) => s.updateProxyAuth);
  const addBypassHost = useSettingsStore((s) => s.addBypassHost);
  const removeBypassHost = useSettingsStore((s) => s.removeBypassHost);
  const proxy = settings.proxy;
  const bypassList = proxy.bypassList ?? [];
  const [newBypass, setNewBypass] = useState('');
  const commitBypass = () => {
    const host = newBypass.trim();
    if (!host) return;
    addBypassHost(host);
    setNewBypass('');
  };

  return (
    <>
      <SectionHeader
        icon={Network}
        title="Proxy"
        description={
          <>
            Route outgoing requests through an HTTP(S) or SOCKS proxy.
            <DesktopOnlyBadge title="Browsers can't tunnel through an arbitrary proxy. Proxy settings only take effect in the Restura desktop app." />
          </>
        }
      />
      <FieldGroup label="Outbound proxy">
        <FieldRow
          label="Enable proxy"
          hint="When off, requests go directly to the upstream host."
          control={
            <ToggleField
              checked={settings.proxy.enabled}
              onChange={setProxyEnabled}
              ariaLabel="Enable proxy"
            />
          }
        />
        <FieldRow
          label="Type"
          hint="HTTP(S) proxies tunnel via CONNECT; SOCKS4/5 open a raw TCP tunnel."
          control={
            <Segmented<Exclude<ProxyType, 'none'>>
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS' },
                { value: 'socks4', label: 'SOCKS4' },
                { value: 'socks5', label: 'SOCKS5' },
              ]}
              value={settings.proxy.type === 'none' ? 'http' : settings.proxy.type}
              onChange={(type) => updateProxy({ type })}
              size="sm"
              ariaLabel="Proxy type"
            />
          }
        />
        <FieldRow
          label="Host"
          control={
            <TextField
              mono
              placeholder="proxy.example.com"
              value={settings.proxy.host}
              onChange={(event) => updateProxy({ host: event.target.value })}
              disabled={!settings.proxy.enabled}
              className="w-[260px]"
            />
          }
        />
        <FieldRow
          label="Port"
          control={
            <Stepper
              value={settings.proxy.port}
              onChange={(value) => updateProxy({ port: value })}
              min={1}
              max={65535}
              ariaLabel="Proxy port"
            />
          }
        />
      </FieldGroup>
      <FieldGroup label="Authentication">
        <FieldRow
          label="Username"
          hint="Leave blank for an unauthenticated proxy."
          control={
            <TextField
              mono
              placeholder="proxy-user"
              value={proxy.auth?.username ?? ''}
              onChange={(event) => updateProxyAuth({ username: event.target.value })}
              disabled={!proxy.enabled}
              className="w-[260px]"
            />
          }
        />
        <FieldRow
          label="Password"
          hint="Stored as a keychain handle on desktop; the renderer never sees the plaintext."
          control={
            <div className="w-[260px]">
              <SecretInput
                value={proxy.auth?.password}
                onChange={(password) => updateProxyAuth({ password })}
                placeholder="Proxy password"
                storageLabel="Proxy password"
                disabled={!proxy.enabled}
              />
            </div>
          }
        />
      </FieldGroup>
      <section className="mt-5">
        <SectionLabel>Bypass list</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
          <p className="text-sp-11 text-sp-muted">
            Hosts that skip the proxy and connect directly. Supports wildcards like{' '}
            <span className="font-mono">*.example.com</span> and{' '}
            <span className="font-mono">192.168.*</span>.
          </p>
          {bypassList.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {bypassList.map((host) => (
                <Badge
                  key={host}
                  variant="mono"
                  className="gap-1.5 h-7 pl-2.5 pr-1.5 rounded-sp-pill text-sp-11-5 text-sp-text"
                >
                  {host}
                  <button
                    type="button"
                    onClick={() => removeBypassHost(host)}
                    aria-label={`Remove ${host} from bypass list`}
                    className={cn(
                      'inline-flex items-center justify-center w-4 h-4 rounded-full',
                      'text-sp-muted hover:text-rose-400 transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                    )}
                  >
                    <X size={11} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <TextField
              mono
              placeholder="internal.example.com"
              value={newBypass}
              onChange={(event) => setNewBypass(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitBypass();
                }
              }}
              className="flex-1"
            />
            <ProxyActionButton icon={Plus} onClick={commitBypass} disabled={!newBypass.trim()}>
              Add
            </ProxyActionButton>
          </div>
        </Floater>
      </section>
    </>
  );
}

function ProxyActionButton({
  icon: Icon,
  onClick,
  disabled,
  children,
}: {
  icon: typeof Plus;
  onClick: () => void;
  disabled: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn text-sp-12 font-medium border',
        'border-sp-line bg-sp-surface text-sp-text hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </button>
  );
}
