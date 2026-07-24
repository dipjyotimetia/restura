'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import {
  Database,
  Download,
  Info,
  Keyboard as KeyboardIcon,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { CaptureBridgeCard } from '@/components/shared/CaptureBridgeCard';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Logo } from '@/components/shared/Logo';
import { useReleaseNotes } from '@/components/shared/settings/useReleaseNotes';
import { Badge } from '@/components/ui/badge';
import { Floater, Kbd, Segmented, TextField, ToggleField } from '@/components/ui/spatial';
import { CertificateOverride } from '@/features/http/components/CertificateOverride';
import { useStorageMonitor } from '@/hooks/useStorageMonitor';
import {
  clearDexieStorage,
  exportDexieData,
  importDexieData,
  secureDeleteAllDexieData,
} from '@/lib/shared/dexie-storage';
import { downloadBlob, readFileAsText } from '@/lib/shared/file-utils';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { looksLikePemCertificate } from '@/lib/shared/pemValidation';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { parseReleaseNoteContent, type ReleaseNotesChannel } from '@/lib/shared/release-notes';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import { type ClientCert, DEFAULT_AUTO_UPDATE_SETTINGS, DEFAULT_JUDGE_SETTINGS } from '@/types';
import { SettingsNavigation } from './components/SettingsNavigation';
import {
  FieldGroup,
  FieldRow,
  SectionHeader,
  SectionLabel,
} from './components/SettingsSectionPrimitives';
import { AppearanceSection } from './sections/AppearanceSection';
import { GeneralSection } from './sections/GeneralSection';
import { ProxySection, RequestsSection } from './sections/NetworkSections';
import type { SectionId, SettingsDrawerProps } from './types';

export type { SectionId, SettingsDrawerProps } from './types';

const ProviderSettings = lazyComponent(async () => {
  const m = await import('@/features/ai/components/ProviderSettings');
  const Comp: React.ComponentType<object> = m.ProviderSettings;
  return { default: Comp };
});

const SHORTCUT_GROUPS: Array<{
  title: string;
  shortcuts: Array<{ keys: string[]; description: string }>;
}> = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open command palette' },
      { keys: ['⌘', '/'], description: 'Show keyboard shortcuts' },
      { keys: ['⌘', ','], description: 'Open settings' },
      { keys: ['⌘', 'N'], description: 'New request' },
    ],
  },
  {
    title: 'Request Builder',
    shortcuts: [
      { keys: ['⌘', '↵'], description: 'Send request' },
      { keys: ['⌘', 'S'], description: 'Save request to collection' },
      { keys: ['⌥', '1'], description: 'Switch to Params tab' },
      { keys: ['⌥', '2'], description: 'Switch to Headers tab' },
      { keys: ['⌥', '3'], description: 'Switch to Body tab' },
      { keys: ['⌥', '4'], description: 'Switch to Auth tab' },
      { keys: ['⌥', '5'], description: 'Switch to Scripts tab' },
      { keys: ['⌥', '6'], description: 'Switch to Settings tab' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['⌘', '1'], description: 'HTTP mode' },
      { keys: ['⌘', '2'], description: 'gRPC mode' },
      { keys: ['⌘', '3'], description: 'WebSocket mode' },
      { keys: ['⌘', 'I'], description: 'Import collection' },
      { keys: ['⌘', 'E'], description: 'Export collection' },
    ],
  },
  {
    title: 'Response',
    shortcuts: [
      { keys: ['⌘', 'C'], description: 'Copy response body' },
      { keys: ['⌘', 'S'], description: 'Save response to file' },
    ],
  },
];

export default function SettingsDrawer({
  open,
  onOpenChange,
  initialSection = 'general',
}: SettingsDrawerProps) {
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection);

  // Reset to the requested initial section whenever the drawer reopens.
  useEffect(() => {
    if (open) setActiveSection(initialSection);
  }, [open, initialSection]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
          style={{
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
          }}
        />
        <DialogPrimitive.Content
          aria-label="Settings"
          className={cn(
            'fixed top-0 right-0 z-50 flex flex-col',
            'h-screen w-[760px] max-w-[100vw]',
            'border-l border-sp-line-strong',
            'outline-none'
          )}
          style={{
            background: 'var(--sp-surface-hi)',
            boxShadow: '-30px 0 80px rgba(0,0,0,0.5)',
            animation: open ? 'sp-drawer-in .25s cubic-bezier(.2,.7,.3,1)' : undefined,
          }}
        >
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Configure Restura preferences
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-center justify-between px-5 h-16 border-b border-sp-line shrink-0">
            <div className="flex items-center gap-3">
              <Logo size={26} />
              <div className="flex flex-col leading-tight">
                <span className="text-sp-16 font-bold text-sp-text">Settings</span>
                <span className="text-sp-11 text-sp-muted">Tune Restura to match how you work</span>
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="Close settings"
              className={cn(
                'inline-flex items-center justify-center w-9 h-9 rounded-sp-btn',
                'bg-sp-surface-lo border border-sp-line text-sp-muted',
                'hover:text-sp-text hover:bg-sp-hover hover:border-sp-line-strong',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'transition-colors'
              )}
            >
              <X size={14} />
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex flex-1 min-h-0">
            <SettingsNavigation activeSection={activeSection} onSectionChange={setActiveSection} />

            {/* Section content */}
            <div className="flex-1 overflow-y-auto px-7 py-6">
              {activeSection === 'general' && <GeneralSection />}
              {activeSection === 'appearance' && <AppearanceSection />}
              {activeSection === 'requests' && <RequestsSection />}
              {activeSection === 'proxy' && <ProxySection />}
              {activeSection === 'certificates' && <CertificatesSection />}
              {activeSection === 'security' && <SecuritySection />}
              {activeSection === 'secrets' && <SecretsSection />}
              {activeSection === 'ai' && isElectron() && (
                <>
                  <ProviderSettings />
                  <JudgeSettingsSection />
                </>
              )}
              {activeSection === 'ai' && !isElectron() && (
                <div className="text-sm text-muted-foreground">
                  AI features are available in the desktop app only.
                </div>
              )}
              {activeSection === 'data' && (
                <>
                  <DataSection />
                  <CaptureBridgeCard />
                </>
              )}
              {activeSection === 'updates' && <UpdatesSection />}
              {activeSection === 'shortcuts' && <ShortcutsSection />}
              {activeSection === 'about' && <AboutSection />}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section helpers                                                            */
/* -------------------------------------------------------------------------- */

/*  Semantic-assertion judge (rs.judge)                                        */
/* -------------------------------------------------------------------------- */

const JUDGE_PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'Compatible' },
];

function JudgeSettingsSection() {
  const judge = useSettingsStore((s) => s.settings.judge) ?? DEFAULT_JUDGE_SETTINGS;
  const updateJudge = useSettingsStore((s) => s.updateJudge);
  const isLocal = isLocalProvider(judge.provider);
  const [pendingKey, setPendingKey] = useState('');

  // The plaintext key never lands in the store — it's stored in the OS keychain
  // (same path as the AI assistant) and only its handle id is persisted.
  const saveJudgeKey = async () => {
    const value = pendingKey.trim();
    if (!value) return;
    const api = getElectronAPI()?.secrets;
    if (!api) return;
    const result = await api.store({ scope: 'ai:judge', value, label: 'judge key' });
    if (!result.ok) {
      toast.error(`Failed to store key: ${result.error}`);
      return;
    }
    updateJudge({ apiKeyHandleId: result.id });
    setPendingKey('');
    toast.success('Judge API key stored');
  };

  const clearJudgeKey = async () => {
    const api = getElectronAPI()?.secrets;
    if (judge.apiKeyHandleId && api) {
      await api.delete(judge.apiKeyHandleId);
    }
    updateJudge({ apiKeyHandleId: undefined });
  };

  return (
    <FieldGroup label="Semantic assertions (rs.judge)">
      <FieldRow
        label="Enable LLM judge"
        hint="Lets test scripts call rs.judge(output, { rubric }) to assert on response meaning."
        control={
          <ToggleField
            checked={judge.enabled}
            onChange={(v) => updateJudge({ enabled: v })}
            ariaLabel="Enable LLM judge"
          />
        }
      />
      <FieldRow
        label="Judge provider"
        control={
          <Segmented<Provider>
            value={judge.provider}
            onChange={(v) => updateJudge({ provider: v })}
            options={JUDGE_PROVIDERS}
          />
        }
      />
      <FieldRow
        label="Judge model"
        hint="e.g. gpt-4o-mini, claude-3-5-haiku, or a local Ollama model."
        control={
          <TextField
            mono
            placeholder="gpt-4o-mini"
            value={judge.model}
            onChange={(e) => updateJudge({ model: e.target.value })}
            disabled={!judge.enabled}
            className="w-[260px]"
          />
        }
      />
      {isLocal && (
        <FieldRow
          label="Base URL"
          hint="Required for local runtimes (e.g. http://localhost:11434)."
          control={
            <TextField
              mono
              placeholder="http://localhost:11434"
              value={judge.baseUrl ?? ''}
              onChange={(e) => updateJudge({ baseUrl: e.target.value })}
              disabled={!judge.enabled}
              className="w-[260px]"
            />
          }
        />
      )}
      <FieldRow
        label="API key"
        hint={
          isLocal
            ? 'Optional for local runtimes (only if your gateway requires auth).'
            : 'Required for cloud providers. Stored in the OS keychain; the renderer never sees it.'
        }
        control={
          judge.apiKeyHandleId ? (
            <div className="flex items-center gap-2">
              <span className="text-sp-12 font-mono text-sp-muted">
                handle {judge.apiKeyHandleId.slice(0, 8)}…
              </span>
              <DataButton icon={Trash2} danger onClick={() => void clearJudgeKey()}>
                Clear
              </DataButton>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <TextField
                type="password"
                mono
                placeholder="sk-…"
                value={pendingKey}
                onChange={(e) => setPendingKey(e.target.value)}
                disabled={!judge.enabled}
                className="w-[200px]"
              />
              <DataButton
                icon={KeyRound}
                disabled={!judge.enabled || !pendingKey.trim()}
                onClick={() => void saveJudgeKey()}
              >
                Save
              </DataButton>
            </div>
          )
        }
      />
      <FieldRow
        label="Redact before judging"
        hint="Strip secret-looking tokens from the response before it is sent to the judge. For sensitive APIs, prefer a local Ollama judge so responses never leave your machine."
        control={
          <ToggleField
            checked={judge.redactBeforeJudge}
            onChange={(v) => updateJudge({ redactBeforeJudge: v })}
            ariaLabel="Redact before judging"
          />
        }
      />
    </FieldGroup>
  );
}

/* -------------------------------------------------------------------------- */
/*  Certificates                                                               */
/* -------------------------------------------------------------------------- */

function CertificatesSection() {
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
/*  Security                                                                   */
/* -------------------------------------------------------------------------- */

function SecuritySection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <>
      <SectionHeader
        icon={ShieldAlert}
        title="Security"
        description="Control which hosts Restura is allowed to reach."
      />

      <FieldGroup label="Outbound targets">
        <FieldRow
          label="Allow localhost"
          hint="Permit requests to localhost, 127.0.0.1, and ::1. Turn off to block loopback targets."
          control={
            <ToggleField
              checked={settings.allowLocalhost ?? true}
              onChange={(v) => updateSettings({ allowLocalhost: v })}
              ariaLabel="Allow localhost"
            />
          }
        />
        <FieldRow
          label="Allow private / internal IPs"
          hint="Permit RFC-1918 (10.x, 172.16.x, 192.168.x), CGNAT, and link-local targets. Cloud-metadata endpoints stay blocked. Leave off unless you need to reach internal hosts."
          control={
            <ToggleField
              checked={settings.allowPrivateIPs === true}
              onChange={(v) => updateSettings({ allowPrivateIPs: v })}
              ariaLabel="Allow private and internal IP addresses"
            />
          }
        />
      </FieldGroup>

      <p className="text-sp-11-5 text-sp-muted mt-4 flex items-start gap-1.5">
        <Info size={13} className="shrink-0 mt-0.5 text-sp-accent" aria-hidden="true" />
        <span>
          On the desktop app these govern Restura&rsquo;s HTTP, WebSocket, SSE, Socket.IO, gRPC, and
          MCP requests. In the browser they gate an in-app pre-check only — the hosted web app and
          self-host server enforce their own network policy, which always takes precedence.
          Cloud-metadata endpoints (e.g. <span className="font-mono">169.254.169.254</span>) are
          blocked on every platform, regardless of these settings. Kafka and MQTT brokers follow
          protocol-appropriate rules — private/LAN broker addresses stay reachable (cloud-metadata
          is still blocked) — so these two toggles don&rsquo;t restrict them.
        </span>
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Secrets                                                                    */
/* -------------------------------------------------------------------------- */

interface SecretHandleSummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}

function SecretsSection() {
  const electron = isElectron();
  const [handles, setHandles] = useState<SecretHandleSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!electron) return;
    const api = getElectronAPI();
    if (!api?.secrets?.list) return;
    setLoading(true);
    try {
      const result = await api.secrets.list();
      if (result.ok) {
        setHandles(result.handles);
      } else {
        toast.error(`Failed to load handles: ${result.error}`);
      }
    } finally {
      setLoading(false);
    }
  }, [electron]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (id: string) => {
    const api = getElectronAPI();
    if (!api?.secrets?.delete) return;
    const result = await api.secrets.delete(id);
    if (!result.ok) {
      toast.error(`Failed to delete: ${result.error}`);
      return;
    }
    toast.success('Secret deleted');
    void refresh();
  };

  if (!electron) {
    return (
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description={
          <>
            Tokens and keys referenced from your collections.
            <DesktopOnlyBadge title="Secret storage requires the Restura desktop app — the browser has no OS keychain." />
          </>
        }
      />
    );
  }

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title="Secrets"
        description="Plaintext for these handles lives in the OS keychain. Restura never reads them in the renderer; the main process resolves them at the wire boundary only when a request is sent."
      />

      <SectionLabel>Stored handles</SectionLabel>
      {loading ? (
        <Floater radius="panel" elevation="inset" className="p-4">
          <p className="text-sp-12 text-sp-muted font-mono">Loading…</p>
        </Floater>
      ) : handles.length === 0 ? (
        <Floater radius="panel" elevation="inset" className="p-5">
          <p className="text-sp-13 text-sp-muted">
            No stored secrets yet. Use the &ldquo;Store&rdquo; button next to a password field in
            any auth configuration to create a handle.
          </p>
        </Floater>
      ) : (
        <Floater radius="panel" elevation="inset" className="overflow-hidden">
          <ul className="divide-y divide-sp-line">
            {handles.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <KeyRound className="h-3.5 w-3.5 text-sp-muted shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sp-12 font-mono text-sp-text truncate">
                      {h.label || h.id.slice(0, 8) + '…'}
                    </p>
                    <p className="text-sp-11 text-sp-muted font-mono">
                      {new Date(h.createdAt).toLocaleString()}
                      {h.scope ? ` · scope: ${h.scope}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(h.id)}
                  aria-label={`Delete handle ${h.label || h.id}`}
                  title="Delete this handle"
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-sp-btn shrink-0',
                    'text-sp-muted hover:text-rose-400 hover:bg-sp-hover transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                  )}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        </Floater>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Data                                                                       */
/* -------------------------------------------------------------------------- */

/** Pill button matching the drawer's other inline actions. */
function DataButton({
  onClick,
  disabled,
  icon: Icon,
  danger,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn text-sp-12 font-medium border',
        'transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        danger
          ? 'border-rose-500/30 bg-rose-500/5 text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 hover:border-rose-400/60'
          : 'border-sp-line bg-sp-surface text-sp-text hover:bg-sp-hover'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </button>
  );
}

function DataSection() {
  // autoPrune:false — this is a display-only usage indicator; don't silently
  // prune history just because the user opened the Data tab.
  const { status, checkStorage, formattedUsed, formattedAvailable } = useStorageMonitor({
    autoPrune: false,
  });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'clear' | 'secure'>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (action: () => Promise<void>, success: string, failPrefix: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        await checkStorage();
        toast.success(success);
        return true;
      } catch (e) {
        toast.error(`${failPrefix}: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkStorage]
  );

  // Import / clear / secure-delete rewrite Dexie out from under the in-memory
  // Zustand stores, which would otherwise re-persist their stale state over the
  // new rows. Reload once the success toast has had a moment to show so the
  // freshly persisted data is what boots.
  const reloadAfter = (ok: boolean) => {
    if (ok) setTimeout(() => window.location.reload(), 900);
  };

  const handleExport = () =>
    run(
      async () =>
        downloadBlob(
          await exportDexieData(),
          `restura-backup-${new Date().toISOString().split('T')[0]}.json`
        ),
      'Data exported',
      'Export failed'
    );

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(
      async () => importDexieData(await file.text()),
      'Data imported — reloading…',
      'Import failed'
    ).then(reloadAfter);
  };

  const confirmDestructive = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'clear') {
      void run(clearDexieStorage, 'All data cleared — reloading…', 'Clear failed').then(
        reloadAfter
      );
    } else if (which === 'secure') {
      void run(
        secureDeleteAllDexieData,
        'All data securely deleted — reloading…',
        'Secure delete failed'
      ).then(reloadAfter);
    }
  };

  const levelColor =
    status.level === 'critical'
      ? '#f43f5e'
      : status.level === 'warning'
        ? '#f59e0b'
        : 'var(--sp-accent)';

  return (
    <>
      <SectionHeader
        icon={Database}
        title="Data"
        description="Back up, restore, or wipe your locally stored data. Everything stays on this device."
      />

      <section className="mt-5 first:mt-0">
        <SectionLabel>Storage usage</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 space-y-2">
          <div className="flex items-center justify-between text-sp-12 font-mono text-sp-muted">
            <span>
              {status.totalRecords} records · {formattedUsed}
            </span>
            <span>
              {status.percentage.toFixed(1)}% of {formattedAvailable}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-sp-line overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                // Floor the width so a non-empty store still shows a sliver of fill
                // (0.0% of a 10 GB quota would otherwise render an empty track).
                width: `${status.totalRecords > 0 ? Math.max(2, Math.min(100, status.percentage)) : 0}%`,
                background: levelColor,
              }}
            />
          </div>
          {status.message && (
            <p className="text-sp-11 text-amber-500 dark:text-amber-400">{status.message}</p>
          )}
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Backup</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => void handleExport()} disabled={busy} icon={Download}>
            Export data
          </DataButton>
          <DataButton onClick={() => fileInputRef.current?.click()} disabled={busy} icon={Upload}>
            Import data
          </DataButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
            aria-label="Import data file"
          />
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Danger zone</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => setConfirm('clear')} disabled={busy} icon={Trash2} danger>
            Clear all data
          </DataButton>
          <DataButton onClick={() => setConfirm('secure')} disabled={busy} icon={Trash2} danger>
            Secure delete
          </DataButton>
        </Floater>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        variant="destructive"
        title={confirm === 'secure' ? 'Securely delete all data?' : 'Clear all data?'}
        description={
          confirm === 'secure'
            ? 'Overwrites every stored record with random data before deleting it, then wipes the database — for use on a shared machine. This cannot be undone.'
            : 'Permanently deletes all collections, history, environments, and settings from this device. This cannot be undone.'
        }
        confirmText={confirm === 'secure' ? 'Secure delete' : 'Clear all'}
        onConfirm={confirmDestructive}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shortcuts                                                                  */
/* -------------------------------------------------------------------------- */

function ShortcutsSection() {
  return (
    <>
      <SectionHeader
        icon={KeyboardIcon}
        title="Shortcuts"
        description="Keyboard bindings available across the app."
      />

      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} className="mt-5 first:mt-0">
          <SectionLabel>{group.title}</SectionLabel>
          <Floater
            radius="panel"
            elevation="inset"
            className="px-4 grid grid-cols-2 gap-x-6 divide-x divide-sp-line"
          >
            {[0, 1].map((col) => (
              <ul
                key={col}
                className="divide-y divide-sp-line"
                style={{ paddingLeft: col === 1 ? '1.5rem' : 0 }}
              >
                {group.shortcuts
                  .filter((_, i) => i % 2 === col)
                  .map((s) => (
                    <li
                      key={s.description}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="text-sp-12-5 text-sp-text">{s.description}</span>
                      <span className="inline-flex items-center gap-1 shrink-0">
                        {s.keys.map((k, i) => (
                          <Kbd key={i} size="xs">
                            {k}
                          </Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
              </ul>
            ))}
          </Floater>
        </section>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  About                                                                      */
/* -------------------------------------------------------------------------- */

function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56v-2.16c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.3-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.55C20.21 21.4 23.5 17.09 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Updates                                                                    */
/* -------------------------------------------------------------------------- */

function formatReleaseDate(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(isoDate));
}

function ReleaseNoteMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkChildren, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sp-accent underline underline-offset-2"
          >
            {linkChildren}
          </a>
        ),
        code: ({ children: codeChildren }) => (
          <code className="rounded bg-sp-hover px-1 py-0.5 font-mono text-sp-11 text-sp-text">
            {codeChildren}
          </code>
        ),
        img: () => null,
        p: ({ children: paragraphChildren }) => <>{paragraphChildren}</>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function ReleaseNotesPanel({ channel }: { channel: ReleaseNotesChannel }) {
  const {
    releases,
    selectedId,
    setSelectedId,
    nextPage,
    loading,
    loadingMore,
    error,
    reload,
    loadMore,
  } = useReleaseNotes(channel);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());

  const selected = releases.find((release) => release.id === selectedId) ?? releases[0];
  const content = selected ? parseReleaseNoteContent(selected.body) : null;

  return (
    <section className="mt-6" aria-labelledby="release-notes-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="release-notes-heading" className="text-sp-14 font-semibold text-sp-text">
            Release notes
          </h3>
          <p className="mt-1 text-sp-12 text-sp-muted">
            Published release history from GitHub.{' '}
            {channel === 'beta' ? 'Beta releases included.' : 'Stable releases only.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload(true)}
          disabled={loading}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
            'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
            'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden />
          Refresh
        </button>
      </div>

      {loading && <p className="mt-4 text-sp-12 text-sp-muted">Loading release notes…</p>}

      {!loading && error && (
        <div className="mt-4 rounded-sp-btn border border-red-500/30 bg-red-500/10 p-3 text-sp-12 text-red-200">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void reload(true)}
            className="mt-2 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && releases.length === 0 && (
        <p className="mt-4 text-sp-12 text-sp-muted">
          No published release notes are available yet.
        </p>
      )}

      {!loading && !error && selected && (
        <div className="mt-4 grid min-h-56 grid-cols-[10.5rem_minmax(0,1fr)] overflow-hidden rounded-sp-btn border border-sp-line bg-sp-surface-lo">
          <div className="max-h-80 overflow-y-auto border-r border-sp-line p-1.5">
            {releases.map((release) => (
              <button
                key={release.id}
                type="button"
                aria-pressed={release.id === selected.id}
                onClick={() => setSelectedId(release.id)}
                className={cn(
                  'w-full rounded-sp-btn px-2.5 py-2 text-left transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                  release.id === selected.id
                    ? 'bg-sp-active text-sp-text'
                    : 'text-sp-muted hover:bg-sp-hover hover:text-sp-text'
                )}
              >
                <span className="block text-sp-12 font-semibold">{release.name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-sp-11 text-sp-dim">
                  {formatReleaseDate(release.publishedAt)}
                  {release.isPrerelease && <Badge variant="secondary">Beta</Badge>}
                </span>
              </button>
            ))}
            {nextPage != null && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="mt-1 w-full rounded-sp-btn px-2.5 py-2 text-sp-11 font-medium text-sp-accent hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load older releases'}
              </button>
            )}
          </div>
          <article className="max-h-80 overflow-y-auto p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sp-14 font-semibold text-sp-text">{selected.name}</h4>
                <p className="mt-0.5 text-sp-11 text-sp-muted">{selected.tag}</p>
              </div>
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${selected.tag} on GitHub`}
                className="text-sp-11 font-medium text-sp-accent underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
              >
                View on GitHub
              </a>
            </div>
            {selected.body ? (
              <div className="mt-4 space-y-4 text-sp-12 leading-5 text-sp-muted">
                {content?.preamble ? (
                  <div className="space-y-2 break-words [&_h1]:text-sp-14 [&_h1]:font-semibold [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h3]:text-sp-12 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    <ReleaseNoteMarkdown>{content.preamble}</ReleaseNoteMarkdown>
                  </div>
                ) : null}

                {content?.highlights ? (
                  <section
                    aria-labelledby="release-highlights-heading"
                    className="rounded-sp-btn border border-sp-accent/25 bg-sp-accent/8 p-3"
                  >
                    <h5
                      id="release-highlights-heading"
                      className="text-sp-12 font-semibold text-sp-text"
                    >
                      Highlights
                    </h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:marker:text-sp-accent [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{content.highlights}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ) : null}

                {content?.upgradeNotes ? (
                  <section
                    aria-labelledby="release-upgrade-notes-heading"
                    className="rounded-sp-btn border border-amber-500/25 bg-amber-500/8 p-3"
                  >
                    <h5
                      id="release-upgrade-notes-heading"
                      className="text-sp-12 font-semibold text-sp-text"
                    >
                      Upgrade notes
                    </h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{content.upgradeNotes}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ) : null}

                {content?.sections.map((section) => {
                  const expanded = expandedSections.has(section.title);
                  return (
                    <section key={section.title} className="rounded-sp-btn border border-sp-line">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSections((current) => {
                            const next = new Set(current);
                            if (next.has(section.title)) next.delete(section.title);
                            else next.add(section.title);
                            return next;
                          })
                        }
                        aria-expanded={expanded}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sp-12 font-semibold text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
                      >
                        <span>{section.title}</span>
                        <span className="text-sp-11 font-medium text-sp-muted">
                          {section.itemCount} {section.itemCount === 1 ? 'change' : 'changes'}
                        </span>
                      </button>
                      {expanded ? (
                        <div className="border-t border-sp-line px-6 py-2.5 [&_ul]:space-y-1.5 [&_ul]:list-disc">
                          <ReleaseNoteMarkdown>{section.body}</ReleaseNoteMarkdown>
                        </div>
                      ) : null}
                    </section>
                  );
                })}

                {content?.contributors ? (
                  <p className="text-sp-11 text-sp-dim">
                    <ReleaseNoteMarkdown>{content.contributors}</ReleaseNoteMarkdown>
                  </p>
                ) : null}

                {content?.extraSections.map((section) => (
                  <section key={section.title} className="rounded-sp-btn border border-sp-line p-3">
                    <h5 className="text-sp-12 font-semibold text-sp-text">{section.title}</h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{section.body}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ))}

                {content?.fallbackBody ? (
                  <div className="space-y-2 break-words [&_h1]:text-sp-14 [&_h1]:font-semibold [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h3]:text-sp-12 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    <ReleaseNoteMarkdown>{content.fallbackBody}</ReleaseNoteMarkdown>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sp-12 text-sp-muted">
                No release notes were provided for this release.
              </p>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

function UpdatesSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const autoUpdate = settings.autoUpdate ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const handleCheck = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.updater.check();
      if (res.error) setCheckResult(`Check failed: ${res.error}`);
      else if (res.updateAvailable)
        setCheckResult(`Update available${res.version ? ` — v${res.version}` : ''}`);
      else setCheckResult(res.message ?? "You're up to date");
    } finally {
      setChecking(false);
    }
  }, []);

  if (!isElectron()) {
    return (
      <>
        <SectionHeader
          icon={Download}
          title="Updates"
          description="Automatic updates for the Restura desktop app."
        />
        <FieldGroup label="Updates">
          <FieldRow
            label="Current version"
            hint="The web app always serves the latest version — no manual update needed."
            control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
          />
          <FieldRow
            label="Desktop auto-update"
            hint="Background updates are available in the Restura desktop app."
            control={<DesktopOnlyBadge title="Auto-update is an Electron desktop feature." />}
          />
        </FieldGroup>
        <ReleaseNotesPanel channel="stable" />
      </>
    );
  }

  return (
    <>
      <SectionHeader
        icon={Download}
        title="Updates"
        description="Keep Restura up to date automatically, or check on demand."
      />

      <FieldGroup label="Automatic updates">
        <FieldRow
          label="Download updates automatically"
          hint="When on, new versions download in the background and prompt you to restart."
          control={
            <ToggleField
              checked={autoUpdate.autoDownload}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, autoDownload: v } })}
              ariaLabel="Download updates automatically"
            />
          }
        />
        <FieldRow
          label="Release channel"
          hint="Stable is recommended. Beta receives pre-releases earlier."
          control={
            <Segmented<'stable' | 'beta'>
              value={autoUpdate.channel}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, channel: v } })}
              options={[
                { value: 'stable', label: 'Stable' },
                { value: 'beta', label: 'Beta' },
              ]}
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="Check">
        <FieldRow
          label="Current version"
          control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
        />
        <FieldRow
          label="Check for updates"
          hint={checkResult ?? 'Fetch the latest release from GitHub.'}
          control={
            <button
              type="button"
              onClick={() => void handleCheck()}
              disabled={checking}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
                'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
                'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} aria-hidden />
              <span>{checking ? 'Checking…' : 'Check now'}</span>
            </button>
          }
        />
      </FieldGroup>
      <ReleaseNotesPanel channel={autoUpdate.channel} />
    </>
  );
}

function AboutSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <>
      <SectionHeader icon={Info} title="About" description="Build details and project links." />

      {/* Hero card — large logo + brand + version pill + tagline. Anchors
          the About page so it doesn't read as a settings list. */}
      <Floater radius="panel" elevation="inset" className="p-6 mt-2 relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 0% 0%, var(--sp-accent-glow-33), transparent 55%)',
          }}
        />
        <div className="relative flex items-center gap-5">
          <Logo size={64} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-sp-22 font-bold text-sp-text leading-none">Restura</span>
              <span
                className="inline-flex items-center px-2 h-5 rounded-sp-pill text-sp-11 font-mono font-semibold text-sp-accent border border-sp-line"
                style={{ background: 'var(--sp-accent-glow-33)' }}
              >
                v{version}
              </span>
            </div>
            <p className="text-sp-13 text-sp-muted mt-1.5">
              A modern multi-protocol API client for HTTP, GraphQL, gRPC, WebSocket, and more.
            </p>
            <p className="text-sp-11 text-sp-dim mt-1 font-mono">Spatial Depth design system</p>
          </div>
        </div>
      </Floater>

      <section className="mt-5">
        <SectionLabel>Resources</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          <LinkCard
            icon={<GithubMark size={16} />}
            label="GitHub repository"
            hint="Source code & issues"
            href="https://github.com/dipjyotimetia/restura"
          />
          <LinkCard
            icon={<Info size={16} />}
            label="Documentation"
            hint="docs.restura.dev"
            href="https://docs.restura.dev"
          />
          <LinkCard
            icon={<ShieldCheck size={16} />}
            label="Privacy Policy"
            hint="restura.dev/privacy"
            href="https://restura.dev/privacy"
          />
        </div>
      </section>
    </>
  );
}

interface LinkCardProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  href: string;
}

function LinkCard({ icon, label, hint, href }: LinkCardProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'group flex items-center gap-3 p-3 rounded-sp-btn',
        'bg-sp-surface-lo border border-sp-line',
        'hover:border-sp-accent hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
      )}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center size-9 rounded-sp-btn shrink-0 text-sp-muted group-hover:text-sp-accent transition-colors"
        style={{ background: 'var(--sp-surface)' }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        <div className="text-sp-11-5 text-sp-muted font-mono truncate">{hint}</div>
      </div>
    </a>
  );
}
