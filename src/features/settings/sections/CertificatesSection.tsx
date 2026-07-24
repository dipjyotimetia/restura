import * as React from 'react';
import { Info, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Floater } from '@/components/ui/spatial';
import { CertificateOverride } from '@/features/http/components/CertificateOverride';
import { readFileAsText } from '@/lib/shared/file-utils';
import { looksLikePemCertificate } from '@/lib/shared/pemValidation';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ClientCert } from '@/types';
import { SectionHeader, SectionLabel } from '../components/SettingsSectionPrimitives';

export function CertificatesSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setClientCert = useSettingsStore((s) => s.setClientCert);
  const setCaCert = useSettingsStore((s) => s.setCaCert);
  const [caFileName, setCaFileName] = React.useState('');
  const [pastedCa, setPastedCa] = React.useState(settings.caCert?.pem ?? '');
  const caFileInputRef = React.useRef<HTMLInputElement>(null);

  const handleCaFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      if (!looksLikePemCertificate(text)) {
        toast.error('That file does not look like a PEM certificate (missing BEGIN CERTIFICATE).');
        e.target.value = '';
        return;
      }
      setCaFileName(file.name);
      setPastedCa('');
      setCaCert({ pem: text });
      toast.success(`CA loaded from ${file.name}`);
    } catch {
      toast.error('Failed to read certificate file');
    }
    e.target.value = '';
  };

  const handleCaPaste = (value: string) => {
    setPastedCa(value);
    setCaFileName('');
    // Only commit valid-looking PEM to the store — consistent with the
    // file-select path, which rejects non-PEM. The textarea keeps whatever was
    // typed (with the inline warning below) so a partial/invalid paste never
    // persists an unusable CA that would fail later at the TLS handshake.
    const trimmed = value.trim();
    if (trimmed && looksLikePemCertificate(trimmed)) {
      setCaCert({ pem: trimmed });
    } else {
      setCaCert(undefined);
    }
  };

  const handleClearCa = () => {
    setCaCert(undefined);
    setCaFileName('');
    setPastedCa('');
    if (caFileInputRef.current) caFileInputRef.current.value = '';
  };

  const hasCa = !!settings.caCert?.pem;

  return (
    <>
      <SectionHeader
        icon={ShieldCheck}
        title="Certificates"
        description={
          <>
            Configure client certificates and custom CA bundles.
            <DesktopOnlyBadge title="Browsers can't present client certificates or override the system trust store. Certificates only take effect in the Restura desktop app." />
          </>
        }
      />

      <SectionLabel>Client certificate (mTLS)</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4">
        <CertificateOverride clientCert={settings.clientCert} onCertChange={setClientCert} />
      </Floater>

      <SectionLabel>Custom CA certificate</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            ref={caFileInputRef}
            type="file"
            accept=".pem,.crt,.cer"
            onChange={handleCaFileSelect}
            className="hidden"
            aria-label="Choose CA certificate file"
          />
          <button
            type="button"
            onClick={() => caFileInputRef.current?.click()}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
              'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
              'hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <Upload size={12} aria-hidden="true" />
            Choose file
          </button>
          <span className="text-sp-11-5 text-sp-muted font-mono truncate">
            {caFileName || (hasCa ? '(loaded)' : 'No file chosen')}
          </span>
          {hasCa && (
            <button
              type="button"
              onClick={handleClearCa}
              aria-label="Clear CA certificate"
              className={cn(
                'ml-auto inline-flex items-center justify-center w-7 h-7 rounded-sp-btn',
                'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
              )}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        <div>
          <label htmlFor="ca-pem-paste" className="text-sp-11-5 text-sp-muted block mb-1">
            …or paste a PEM bundle
          </label>
          <textarea
            id="ca-pem-paste"
            aria-label="Paste a PEM bundle"
            value={pastedCa}
            onChange={(e) => handleCaPaste(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----&#10;..."
            spellCheck={false}
            className={cn(
              'w-full min-h-[120px] rounded-sp-btn bg-sp-surface border border-sp-line',
              'p-2 font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
              'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]',
              'transition-colors resize-y'
            )}
          />
          {pastedCa.trim() !== '' && !looksLikePemCertificate(pastedCa) && (
            <p className="text-sp-11 text-amber-500 dark:text-amber-400 mt-1">
              This doesn&rsquo;t look like a PEM certificate yet (missing BEGIN CERTIFICATE).
            </p>
          )}
        </div>
        <p className="text-sp-11 text-amber-500 dark:text-amber-400 flex items-start gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            A custom CA replaces the system trust store for Restura's outbound requests. Only add a
            CA you trust.
          </span>
        </p>
      </Floater>

      <PerDomainCertificates />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Per-domain certificates                                                    */
/* -------------------------------------------------------------------------- */

/** Host[:port] input shared by both per-domain editors. */
function HostScopeFields({
  host,
  port,
  onHostChange,
  onPortChange,
}: {
  host: string;
  port: number | undefined;
  onHostChange: (v: string) => void;
  onPortChange: (v: number | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={host}
        onChange={(e) => onHostChange(e.target.value)}
        aria-label="Host or host pattern"
        placeholder="api.example.com or *.example.com"
        spellCheck={false}
        className={cn(
          'flex-1 h-8 px-2 rounded-sp-btn bg-sp-surface border border-sp-line',
          'font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
          'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]'
        )}
      />
      <input
        value={port ?? ''}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (v === '') {
            onPortChange(undefined);
            return;
          }
          // Guard against NaN / out-of-range: a non-numeric paste would
          // otherwise persist `port: NaN` into the host entry.
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 65535) onPortChange(n);
        }}
        inputMode="numeric"
        aria-label="Port"
        placeholder="port"
        spellCheck={false}
        className={cn(
          'w-20 h-8 px-2 rounded-sp-btn bg-sp-surface border border-sp-line',
          'font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
          'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]'
        )}
      />
    </div>
  );
}

function PerDomainCertificates() {
  const settings = useSettingsStore((s) => s.settings);
  const upsertHostClientCert = useSettingsStore((s) => s.upsertHostClientCert);
  const removeHostClientCert = useSettingsStore((s) => s.removeHostClientCert);
  const upsertHostCaCert = useSettingsStore((s) => s.upsertHostCaCert);
  const removeHostCaCert = useSettingsStore((s) => s.removeHostCaCert);

  const clientCerts = settings.clientCertificates ?? [];
  const caCerts = settings.caCertificates ?? [];

  const newId = () => {
    // crypto.randomUUID is available in the renderer (secure context) and in
    // Electron; fall back to a timestamp-free random for non-secure dev.
    try {
      return crypto.randomUUID();
    } catch {
      return `cert-${Math.random().toString(36).slice(2)}`;
    }
  };

  const addClientCert = () =>
    upsertHostClientCert({ id: newId(), host: '', cert: { format: 'pfx' } });
  const addCaCert = () => upsertHostCaCert({ id: newId(), host: '', pem: '' });

  return (
    <>
      <SectionLabel>Per-domain client certificates</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <p className="text-sp-11 text-sp-muted">
          Present a different mTLS certificate per host. The most specific matching entry wins;
          exact host beats <span className="font-mono">*.wildcard</span>. A match takes precedence
          over the global client certificate above.
        </p>
        {clientCerts.map((entry) => (
          <div key={entry.id} className="rounded-sp-btn border border-sp-line p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <HostScopeFields
                  host={entry.host}
                  port={entry.port}
                  onHostChange={(host) => upsertHostClientCert({ ...entry, host })}
                  onPortChange={(port) =>
                    upsertHostClientCert(port === undefined ? stripPort(entry) : { ...entry, port })
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => removeHostClientCert(entry.id)}
                aria-label="Remove certificate"
                className={cn(
                  'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                  'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <CertificateOverride
              clientCert={entry.cert}
              onCertChange={(cert: ClientCert | undefined) =>
                upsertHostClientCert({ ...entry, cert: cert ?? { format: 'pfx' } })
              }
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addClientCert}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
            'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
            'hover:bg-sp-hover transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Add client certificate
        </button>
      </Floater>

      <SectionLabel>Per-domain CA certificates</SectionLabel>
      <Floater radius="panel" elevation="inset" className="p-4 space-y-3">
        <p className="text-sp-11 text-sp-muted">
          Scope a custom CA to specific hosts. For a matched host this CA <em>replaces</em> the
          default trust store for that request — it is not added to it, so include every root the
          chain needs.
        </p>
        {caCerts.map((entry) => (
          <div key={entry.id} className="rounded-sp-btn border border-sp-line p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <HostScopeFields
                  host={entry.host}
                  port={entry.port}
                  onHostChange={(host) => upsertHostCaCert({ ...entry, host })}
                  onPortChange={(port) =>
                    upsertHostCaCert(port === undefined ? stripPort(entry) : { ...entry, port })
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => removeHostCaCert(entry.id)}
                aria-label="Remove CA certificate"
                className={cn(
                  'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                  'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <textarea
              value={entry.pem}
              onChange={(e) => upsertHostCaCert({ ...entry, pem: e.target.value })}
              aria-label="CA certificate PEM"
              placeholder="-----BEGIN CERTIFICATE-----&#10;..."
              spellCheck={false}
              className={cn(
                'w-full min-h-[90px] rounded-sp-btn bg-sp-surface border border-sp-line',
                'p-2 font-mono text-sp-11-5 text-sp-text placeholder:text-sp-dim',
                'focus:outline-none focus:border-sp-line-strong focus:ring-2 focus:ring-[var(--sp-accent-glow-33)]',
                'transition-colors resize-y'
              )}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addCaCert}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn',
            'bg-sp-surface border border-sp-line text-sp-text font-mono text-sp-12',
            'hover:bg-sp-hover transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Add CA certificate
        </button>
      </Floater>
    </>
  );
}

/** Return a copy of a host-scoped entry with `port` omitted (EOPT-friendly). */
function stripPort<T extends { port?: number }>(entry: T): T {
  const { port: _omit, ...rest } = entry;
  void _omit;
  return rest as T;
}

/* -------------------------------------------------------------------------- */
