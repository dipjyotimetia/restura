'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { CaptureBridgeCard } from '@/components/shared/CaptureBridgeCard';
import { Logo } from '@/components/shared/Logo';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { SettingsNavigation } from './components/SettingsNavigation';
import { AppearanceSection } from './sections/AppearanceSection';
import { AboutSection } from './sections/AboutSection';
import { CertificatesSection } from './sections/CertificatesSection';
import { DataSection } from './sections/DataSection';
import { GeneralSection } from './sections/GeneralSection';
import { JudgeSettingsSection } from './sections/JudgeSettingsSection';
import { ProxySection, RequestsSection } from './sections/NetworkSections';
import { SecretsSection, SecuritySection } from './sections/SecuritySections';
import { ShortcutsSection } from './sections/ShortcutsSection';
import { UpdatesSection } from './sections/UpdatesSection';
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
              {activeSection === 'shortcuts' && <ShortcutsSection groups={SHORTCUT_GROUPS} />}
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

/*  Data                                                                       */
/* -------------------------------------------------------------------------- */

/** Pill button matching the drawer's other inline actions. */
