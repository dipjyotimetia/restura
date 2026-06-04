'use client';

import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Logo } from '@/components/shared/Logo';
import { Floater, Kbd, Segmented, Stepper, TextField, ToggleField } from '@/components/ui/spatial';
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
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ClientCert } from '@/types';
import { DEFAULT_AUTO_UPDATE_SETTINGS, SPATIAL_ACCENT_PRESETS, type SpatialAccent } from '@/types';
import type { JudgeSettings } from '@/types';
import type { Provider } from '@shared/protocol/ai/types';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Check,
  Database,
  Download,
  Info,
  KeyRound,
  Keyboard as KeyboardIcon,
  Network,
  Palette,
  RefreshCw,
  Send,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';

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
  | 'data'
  | 'updates'
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
  { id: 'data', label: 'Data', icon: Database },
  { id: 'updates', label: 'Updates', icon: Download },
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
          <div className="flex items-center justify-between px-5 h-16 border-b border-sp-line shrink-0">
            <div className="flex items-center gap-3">
              <Logo size={26} />
              <div className="flex flex-col leading-tight">
                <span className="text-sp-15 font-bold text-sp-text">Settings</span>
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
            {/* Nav rail */}
            <nav
              aria-label="Settings sections"
              className="w-[220px] shrink-0 border-r border-sp-line py-4 px-2 overflow-y-auto flex flex-col gap-0.5"
            >
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const isActive = activeSection === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveSection(s.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center gap-2.5 w-full text-left rounded-sp-btn',
                      'text-sp-13 transition-all duration-150',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                      isActive
                        ? 'bg-sp-active text-sp-text font-semibold'
                        : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
                    )}
                    style={{ padding: '9px 12px 9px 14px' }}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sp-accent"
                        style={{ boxShadow: '0 0 8px var(--sp-accent-glow-55)' }}
                      />
                    )}
                    <Icon
                      size={14}
                      className={cn(
                        'transition-colors',
                        isActive ? 'text-sp-accent' : 'text-sp-muted'
                      )}
                    />
                    <span>{s.label}</span>
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
              {activeSection === 'data' && <DataSection />}
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

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
}

function SectionHeader({ icon: Icon, title, description }: SectionHeaderProps) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center size-9 rounded-sp-btn border border-sp-line"
        style={{
          background:
            'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <Icon size={16} className="text-sp-accent" />
      </div>
      <div className="min-w-0">
        <h1 className="text-sp-22 font-bold text-sp-text leading-tight">{title}</h1>
        <p className="text-sp-13 text-sp-muted mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="sp-label mt-6 mb-2">{children}</div>;
}

interface FieldGroupProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Frames a labelled cluster of FieldRows in a Floater so the eye reads each
 * settings group as one card. Removes the visual noise of free-floating
 * border-bottom dividers between unrelated rows.
 */
function FieldGroup({ label, children }: FieldGroupProps) {
  return (
    <section className="mt-5 first:mt-0">
      <SectionLabel>{label}</SectionLabel>
      <Floater radius="panel" elevation="inset" className="px-4 divide-y divide-sp-line">
        {children}
      </Floater>
    </section>
  );
}

interface FieldRowProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  control: React.ReactNode;
}

function FieldRow({ label, hint, control }: FieldRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
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
      <SectionHeader
        icon={Sliders}
        title="General"
        description="Workspace defaults that apply to every request."
      />

      <FieldGroup label="Appearance">
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
              value={settings.layoutOrientation ?? 'horizontal'}
              onChange={(v) => updateSettings({ layoutOrientation: v })}
              options={[
                { value: 'horizontal', label: 'Horizontal' },
                { value: 'vertical', label: 'Vertical' },
              ]}
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="History">
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
        />
      </FieldGroup>

      <FieldGroup label="Privacy">
        <FieldRow
          label="Send crash & error reports"
          hint="Helps fix bugs. Only the error message, stack, and app version are sent — never request payloads, headers, or response bodies."
          control={
            <ToggleField
              checked={settings.telemetry?.errorsEnabled ?? true}
              onChange={(v) => updateSettings({ telemetry: { errorsEnabled: v } })}
              ariaLabel="Send crash and error reports"
            />
          }
        />
      </FieldGroup>
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
      <SectionHeader
        icon={Palette}
        title="Appearance"
        description="Pick your accent color and theme."
      />

      <section className="mt-5 first:mt-0">
        <SectionLabel>Accent</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4">
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
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
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
        </Floater>
      </section>

      <FieldGroup label="Theme">
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
        />
      </FieldGroup>
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
              onChange={(v) => updateSettings({ defaultTimeout: Math.max(1, v) * 1000 })}
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
      </FieldGroup>

      <FieldGroup label="History">
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
        />
      </FieldGroup>
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
      <SectionHeader
        icon={Network}
        title="Proxy"
        description="Route outgoing requests through an HTTP(S) or SOCKS proxy."
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
        />
      </FieldGroup>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Semantic-assertion judge (rs.judge)                                        */
/* -------------------------------------------------------------------------- */

const JUDGE_DEFAULTS: JudgeSettings = {
  enabled: false,
  provider: 'openai',
  model: '',
  redactBeforeJudge: true,
};

const JUDGE_PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'Compatible' },
];

function JudgeSettingsSection() {
  const judge = useSettingsStore((s) => s.settings.judge) ?? JUDGE_DEFAULTS;
  const updateJudge = useSettingsStore((s) => s.updateJudge);
  const isLocal = judge.provider === 'ollama' || judge.provider === 'openai-compatible';

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
        label="API key handle"
        hint="SecretRef handle id for the provider key. Leave blank for keyless local runtimes."
        control={
          <TextField
            mono
            placeholder="(optional)"
            value={judge.apiKeyHandleId ?? ''}
            onChange={(e) => updateJudge({ apiKeyHandleId: e.target.value })}
            disabled={!judge.enabled}
            className="w-[260px]"
          />
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
          onPortChange(v === '' ? undefined : Number(v));
        }}
        inputMode="numeric"
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
          Trust a custom CA only for specific hosts (instead of replacing the whole trust store).
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
    async (action: () => Promise<void>, success: string, failPrefix: string) => {
      setBusy(true);
      try {
        await action();
        await checkStorage();
        toast.success(success);
      } catch (e) {
        toast.error(`${failPrefix}: ${e instanceof Error ? e.message : 'Unknown error'}`);
      } finally {
        setBusy(false);
      }
    },
    [checkStorage]
  );

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
      'Data imported — reload to see changes',
      'Import failed'
    );
  };

  const confirmDestructive = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'clear') {
      void run(clearDexieStorage, 'All data cleared — reload to reset', 'Clear failed');
    } else if (which === 'secure') {
      void run(
        secureDeleteAllDexieData,
        'All data securely deleted — reload to reset',
        'Secure delete failed'
      );
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

interface AuthorAvatarProps {
  username: string;
  initials: string;
  alt: string;
}

/**
 * GitHub avatar with graceful fallback. The initials/gradient render as the
 * background, so even before the image loads (or if the fetch fails) the
 * row stays visually anchored. On error we hide the img and let the
 * background show through.
 */
function AuthorAvatar({ username, initials, alt }: AuthorAvatarProps) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="relative flex items-center justify-center size-10 rounded-full overflow-hidden shrink-0 text-sp-13 font-bold text-white"
      style={{
        background: 'linear-gradient(135deg, var(--sp-accent), #a78bfa)',
        boxShadow: '0 4px 12px var(--sp-accent-glow-55)',
      }}
    >
      <span aria-hidden={!failed}>{initials}</span>
      {!failed && (
        <img
          src={`https://github.com/${username}.png?size=80`}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}

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

function UpdatesSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const autoUpdate = settings.autoUpdate ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // Mirror the live updater status so the panel can show release notes and the
  // most recent check outcome even when triggered from the banner or tray.
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api) return;
    return api.updater.onStatus((status) => {
      if (status.state === 'available' || status.state === 'downloaded') {
        setReleaseNotes(status.releaseNotes ?? null);
        setLatestVersion(status.version ?? null);
      }
    });
  }, []);

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

      {releaseNotes && (
        <section className="mt-5">
          <SectionLabel>What&apos;s new{latestVersion ? ` in v${latestVersion}` : ''}</SectionLabel>
          <Floater radius="panel" elevation="inset" className="p-4">
            <div className="text-sp-12 text-sp-muted break-words [&_a]:text-sp-accent [&_a]:underline [&_code]:font-mono [&_h1]:text-sp-13 [&_h1]:font-semibold [&_h1]:text-sp-text [&_h1]:mb-1 [&_h1]:mt-3 [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h2]:text-sp-text [&_h2]:mb-1 [&_h2]:mt-3 [&_h3]:font-semibold [&_h3]:text-sp-text [&_li]:my-0.5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 first:[&>*]:mt-0">
              <ReactMarkdown
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer noopener">
                      {children}
                    </a>
                  ),
                }}
              >
                {releaseNotes}
              </ReactMarkdown>
            </div>
          </Floater>
        </section>
      )}
    </>
  );
}

function AboutSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <>
      <SectionHeader
        icon={Info}
        title="About"
        description="Build details, author, and project links."
      />

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

      <FieldGroup label="Author">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-3">
          <AuthorAvatar username="dipjyotimetia" initials="DM" alt="Dipjyoti Metia" />
          <div className="min-w-0">
            <div className="text-sp-13 font-semibold text-sp-text">Dipjyoti Metia</div>
            <div className="text-sp-11-5 text-sp-muted">Creator &amp; maintainer</div>
          </div>
          <a
            href="https://github.com/dipjyotimetia"
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
              'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
              'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <GithubMark size={13} />
            <span>Follow</span>
          </a>
        </div>
      </FieldGroup>

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
