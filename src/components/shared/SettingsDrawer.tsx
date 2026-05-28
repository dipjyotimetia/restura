'use client';

import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  X,
  Palette,
  Send,
  Network,
  ShieldCheck,
  KeyRound,
  Keyboard as KeyboardIcon,
  Info,
  Check,
  Sliders,
  Trash2,
  Upload,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ToggleField, Segmented, Stepper, TextField, Kbd, Floater } from '@/components/ui/spatial';
import { SPATIAL_ACCENT_PRESETS, type SpatialAccent } from '@/types';
import { cn } from '@/lib/shared/utils';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { readFileAsText } from '@/lib/shared/file-utils';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { CertificateOverride } from '@/features/http/components/CertificateOverride';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Logo } from '@/components/shared/Logo';

const ProviderSettings = lazyComponent(async () => {
  const m = await import('@/features/ai/components/ProviderSettings');
  const Comp: React.ComponentType<object> = m.ProviderSettings;
  return { default: Comp };
});

export type SectionId =
  | 'general'
  | 'appearance'
  | 'requests'
  | 'proxy'
  | 'certificates'
  | 'secrets'
  | 'ai'
  | 'shortcuts'
  | 'about';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'requests', label: 'Requests', icon: Send },
  { id: 'proxy', label: 'Proxy', icon: Network },
  { id: 'certificates', label: 'Certificates', icon: ShieldCheck },
  { id: 'secrets', label: 'Secrets', icon: KeyRound },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'shortcuts', label: 'Shortcuts', icon: KeyboardIcon },
  { id: 'about', label: 'About', icon: Info },
];

const SHORTCUT_GROUPS: Array<{
  title: string;
  shortcuts: Array<{ keys: string[]; description: string }>;
}> = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open command palette' },
      { keys: ['⌘', '/'], description: 'Show keyboard shortcuts' },
      { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
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

export interface SettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Optional section to land on when the drawer opens. Defaults to 'general'.
   * Used by Cmd+/ → 'shortcuts'.
   */
  initialSection?: SectionId;
}

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
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
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
          <div className="flex items-center justify-between px-5 h-14 border-b border-sp-line">
            <div className="flex items-center gap-2.5">
              <Logo size={22} />
              <span className="text-sp-16 font-bold text-sp-text">Settings</span>
            </div>
            <DialogPrimitive.Close
              aria-label="Close settings"
              className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
            >
              <X size={14} />
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex flex-1 min-h-0">
            {/* Nav rail */}
            <nav
              aria-label="Settings sections"
              className="w-[220px] shrink-0 border-r border-sp-line py-3 px-2 overflow-y-auto"
            >
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const isActive = activeSection === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveSection(s.id)}
                    className={cn(
                      'flex items-center gap-2.5 w-full text-left rounded-sp-btn',
                      'text-sp-13 transition-colors',
                      isActive
                        ? 'bg-sp-active text-sp-text'
                        : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
                    )}
                    style={{ padding: '8px 10px' }}
                  >
                    <Icon size={14} className={isActive ? 'text-sp-accent' : ''} />
                    <span className="font-medium">{s.label}</span>
                  </button>
                );
              })}
            </nav>

            {/* Section content */}
            <div className="flex-1 overflow-y-auto px-7 py-6">
              {activeSection === 'general' && <GeneralSection />}
              {activeSection === 'appearance' && <AppearanceSection />}
              {activeSection === 'requests' && <RequestsSection />}
              {activeSection === 'proxy' && <ProxySection />}
              {activeSection === 'certificates' && <CertificatesSection />}
              {activeSection === 'secrets' && <SecretsSection />}
              {activeSection === 'ai' && isElectron() && <ProviderSettings />}
              {activeSection === 'ai' && !isElectron() && (
                <div className="text-sm text-muted-foreground">
                  AI features are available in the desktop app only.
                </div>
              )}
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

function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="text-sp-22 font-bold text-sp-text mb-1">{children}</h1>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sp-label mt-6 mb-2">{children}</div>;
}

interface FieldRowProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  control: React.ReactNode;
  last?: boolean;
}

function FieldRow({ label, hint, control, last }: FieldRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_auto] items-center gap-4 py-3',
        !last && 'border-b border-sp-line'
      )}
    >
      <div className="min-w-0">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        {hint && <div className="text-sp-11-5 text-sp-muted mt-0.5">{hint}</div>}
      </div>
      <div className="justify-self-end">{control}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  General                                                                    */
/* -------------------------------------------------------------------------- */

function GeneralSection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { theme, setTheme } = useTheme();

  const currentTheme = (theme ?? settings.theme ?? 'system') as 'light' | 'dark' | 'system';

  return (
    <>
      <H1>General</H1>
      <p className="text-sp-13 text-sp-muted">Workspace defaults that apply to every request.</p>

      <SectionLabel>Appearance</SectionLabel>
      <FieldRow
        label="Theme"
        hint="Choose how Restura looks. System follows your OS preference."
        control={
          <Segmented<'light' | 'dark' | 'system'>
            value={currentTheme}
            onChange={(v) => {
              setTheme(v);
              updateSettings({ theme: v });
            }}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        }
      />
      <FieldRow
        label="Layout orientation"
        hint="Side-by-side or stacked request/response."
        control={
          <Segmented<'vertical' | 'horizontal'>
            value={settings.layoutOrientation ?? 'vertical'}
            onChange={(v) => updateSettings({ layoutOrientation: v })}
            options={[
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'vertical', label: 'Vertical' },
            ]}
          />
        }
      />

      <SectionLabel>History</SectionLabel>
      <FieldRow
        label="Auto-save history"
        hint="Automatically record every executed request."
        control={
          <ToggleField
            checked={settings.autoSaveHistory ?? true}
            onChange={(v) => updateSettings({ autoSaveHistory: v })}
            ariaLabel="Auto-save history"
          />
        }
        last
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Appearance — accent picker                                                 */
/* -------------------------------------------------------------------------- */

function AppearanceSection() {
  const accent = useSettingsStore((s) => s.settings.accent ?? '#4d9fff');
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { theme, setTheme } = useTheme();
  const currentTheme = (theme ?? 'system') as 'light' | 'dark' | 'system';

  return (
    <>
      <H1>Appearance</H1>
      <p className="text-sp-13 text-sp-muted">Pick your accent color and theme.</p>

      <SectionLabel>Accent</SectionLabel>
      <div className="py-3 border-b border-sp-line">
        <div className="text-sp-13 font-semibold text-sp-text mb-1">Accent color</div>
        <div className="text-sp-11-5 text-sp-muted mb-4">
          Used for active highlights, focus rings, and the Send button.
        </div>
        <div className="flex items-center gap-3">
          {SPATIAL_ACCENT_PRESETS.map((preset) => {
            const isActive = preset === accent;
            return (
              <button
                key={preset}
                type="button"
                aria-label={`Accent ${preset}`}
                aria-pressed={isActive}
                onClick={() => updateSettings({ accent: preset as SpatialAccent })}
                className={cn(
                  'relative inline-flex items-center justify-center',
                  'w-8 h-8 rounded-full border border-sp-line transition-all',
                  isActive && 'scale-110'
                )}
                style={{
                  background: preset,
                  boxShadow: isActive
                    ? `0 0 0 2px var(--sp-surface-hi), 0 0 0 4px ${preset}, 0 0 16px ${preset}66`
                    : 'inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                {isActive && <Check size={14} className="text-white drop-shadow" />}
              </button>
            );
          })}
        </div>
      </div>

      <SectionLabel>Theme</SectionLabel>
      <FieldRow
        label="Color scheme"
        hint="Dark mode applies the full Spatial Depth glass palette."
        control={
          <Segmented<'light' | 'dark' | 'system'>
            value={currentTheme}
            onChange={(v) => setTheme(v)}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        }
        last
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Requests                                                                   */
/* -------------------------------------------------------------------------- */

function RequestsSection() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <>
      <H1>Requests</H1>
      <p className="text-sp-13 text-sp-muted">Defaults for new requests and execution behavior.</p>

      <SectionLabel>Timeouts</SectionLabel>
      <FieldRow
        label="Default timeout"
        hint="Abort requests that don't respond within this window."
        control={
          <Stepper
            value={Math.round((settings.defaultTimeout ?? 30000) / 1000)}
            onChange={(v) => updateSettings({ defaultTimeout: Math.max(1, v) * 1000 })}
            min={1}
            max={600}
            step={5}
            unit="s"
            ariaLabel="Default timeout in seconds"
          />
        }
      />

      <SectionLabel>Redirects & TLS</SectionLabel>
      <FieldRow
        label="Follow redirects"
        hint="Automatically follow HTTP 3xx responses."
        control={
          <ToggleField
            checked={settings.followRedirects ?? true}
            onChange={(v) => updateSettings({ followRedirects: v })}
            ariaLabel="Follow redirects"
          />
        }
      />
      <FieldRow
        label="Max redirects"
        hint="Hard cap on redirect chain length."
        control={
          <Stepper
            value={settings.maxRedirects ?? 10}
            onChange={(v) => updateSettings({ maxRedirects: v })}
            min={0}
            max={50}
            ariaLabel="Max redirects"
          />
        }
      />
      <FieldRow
        label="Verify SSL certificates"
        hint="Disable only for trusted development hosts."
        control={
          <ToggleField
            checked={settings.verifySsl ?? true}
            onChange={(v) => updateSettings({ verifySsl: v })}
            ariaLabel="Verify SSL"
          />
        }
      />

      <SectionLabel>History</SectionLabel>
      <FieldRow
        label="Max history items"
        hint="Older entries are evicted once this cap is reached."
        control={
          <Stepper
            value={settings.maxHistoryItems ?? 100}
            onChange={(v) => updateSettings({ maxHistoryItems: v })}
            min={10}
            max={5000}
            step={10}
            ariaLabel="Max history items"
          />
        }
        last
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Proxy                                                                      */
/* -------------------------------------------------------------------------- */

function ProxySection() {
  const settings = useSettingsStore((s) => s.settings);
  const setProxyEnabled = useSettingsStore((s) => s.setProxyEnabled);
  const updateProxy = useSettingsStore((s) => s.updateProxy);

  return (
    <>
      <H1>Proxy</H1>
      <p className="text-sp-13 text-sp-muted">
        Route outgoing requests through an HTTP(S) or SOCKS proxy.
      </p>

      <SectionLabel>Outbound proxy</SectionLabel>
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
        label="Host"
        control={
          <TextField
            mono
            placeholder="proxy.example.com"
            value={settings.proxy.host}
            onChange={(e) => updateProxy({ host: e.target.value })}
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
            onChange={(v) => updateProxy({ port: v })}
            min={1}
            max={65535}
            ariaLabel="Proxy port"
          />
        }
        last
      />
    </>
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
    if (value.trim()) {
      setCaCert({ pem: value.trim() });
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
      <H1>Certificates</H1>
      <p className="text-sp-13 text-sp-muted">
        Configure client certificates and custom CA bundles.
        <DesktopOnlyBadge title="Browsers can't present client certificates or override the system trust store. Certificates only take effect in the Restura desktop app." />
      </p>

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
        </div>
        <p className="text-sp-11 text-amber-500 dark:text-amber-400 flex items-start gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            A custom CA replaces the system trust store for Restura's outbound requests. Only add a
            CA you trust.
          </span>
        </p>
      </Floater>
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
      <>
        <H1>Secrets</H1>
        <p className="text-sp-13 text-sp-muted">
          Tokens and keys referenced from your collections.
          <DesktopOnlyBadge title="Secret storage requires the Restura desktop app — the browser has no OS keychain." />
        </p>
      </>
    );
  }

  return (
    <>
      <H1>Secrets</H1>
      <p className="text-sp-13 text-sp-muted">
        Plaintext for these handles lives in the OS keychain. Restura never reads them in the
        renderer; the main process resolves them at the wire boundary only when a request is sent.
      </p>

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
/*  Shortcuts                                                                  */
/* -------------------------------------------------------------------------- */

function ShortcutsSection() {
  return (
    <>
      <H1>Shortcuts</H1>
      <p className="text-sp-13 text-sp-muted">Keyboard bindings available across the app.</p>

      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title}>
          <SectionLabel>{group.title}</SectionLabel>
          <div className="grid grid-cols-2 gap-x-8">
            {group.shortcuts.map((s) => (
              <div
                key={s.description}
                className="flex items-center justify-between py-2 border-b border-sp-line"
              >
                <span className="text-sp-13 text-sp-muted">{s.description}</span>
                <span className="inline-flex items-center gap-1">
                  {s.keys.map((k, i) => (
                    <Kbd key={i} size="xs">
                      {k}
                    </Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
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

function AboutSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <>
      <H1>About</H1>
      <p className="text-sp-13 text-sp-muted">Restura — a multi-protocol API client.</p>

      <SectionLabel>Version</SectionLabel>
      <div className="py-3 border-b border-sp-line">
        <div className="text-sp-13 text-sp-text font-mono">v{version}</div>
        <div className="text-sp-11-5 text-sp-muted mt-1">Spatial Depth design system</div>
      </div>

      <SectionLabel>Author</SectionLabel>
      <div className="py-3 border-b border-sp-line">
        <div className="text-sp-13 text-sp-text">Dipjyoti Metia</div>
        <a
          href="https://github.com/dipjyotimetia"
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-1.5 text-sp-11-5 text-sp-muted hover:text-sp-accent transition-colors"
        >
          <GithubMark size={12} />
          <span className="font-mono">github.com/dipjyotimetia</span>
        </a>
      </div>

      <SectionLabel>Links</SectionLabel>
      <div className="py-3 flex flex-col gap-2 text-sp-13">
        <a
          href="https://github.com/dipjyotimetia/restura"
          target="_blank"
          rel="noreferrer noopener"
          className="text-sp-accent hover:underline"
        >
          GitHub repository
        </a>
        <a
          href="https://restura.dev"
          target="_blank"
          rel="noreferrer noopener"
          className="text-sp-accent hover:underline"
        >
          Documentation
        </a>
      </div>
    </>
  );
}
