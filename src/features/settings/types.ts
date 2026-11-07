import type { LucideIcon } from 'lucide-react';

export type SectionId =
  | 'general'
  | 'appearance'
  | 'requests'
  | 'proxy'
  | 'certificates'
  | 'security'
  | 'secrets'
  | 'ai'
  | 'mcp'
  | 'data'
  | 'updates'
  | 'shortcuts'
  | 'about';

export interface SettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Optional section to land on when the drawer opens. Defaults to 'general'.
   * Used by Cmd+/ → 'shortcuts'.
   */
  initialSection?: SectionId;
}

export interface SettingsSectionDefinition {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Extra terms the settings filter matches (what lives in the section). */
  keywords?: readonly string[];
}
