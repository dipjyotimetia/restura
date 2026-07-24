import {
  Database,
  Download,
  Info,
  Keyboard as KeyboardIcon,
  KeyRound,
  Network,
  Palette,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import type { SectionId, SettingsSectionDefinition } from '../types';

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'requests', label: 'Requests', icon: Send },
  { id: 'proxy', label: 'Proxy', icon: Network },
  { id: 'certificates', label: 'Certificates', icon: ShieldCheck },
  { id: 'security', label: 'Security', icon: ShieldAlert },
  { id: 'secrets', label: 'Secrets', icon: KeyRound },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'updates', label: 'Updates', icon: Download },
  { id: 'shortcuts', label: 'Shortcuts', icon: KeyboardIcon },
  { id: 'about', label: 'About', icon: Info },
];

interface SettingsNavigationProps {
  activeSection: SectionId;
  onSectionChange: (section: SectionId) => void;
}

export function SettingsNavigation({ activeSection, onSectionChange }: SettingsNavigationProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="w-[220px] shrink-0 border-r border-sp-line py-4 px-2 overflow-y-auto flex flex-col gap-0.5"
    >
      {SETTINGS_SECTIONS.map((section) => {
        const Icon = section.icon;
        const isActive = activeSection === section.id;

        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSectionChange(section.id)}
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
              className={cn('transition-colors', isActive ? 'text-sp-accent' : 'text-sp-muted')}
            />
            <span>{section.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
