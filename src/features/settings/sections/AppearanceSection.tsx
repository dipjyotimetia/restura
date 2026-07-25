import { Check, Palette } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Floater, Segmented } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { withViewTransition } from '@/lib/shared/viewTransition';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SPATIAL_ACCENT_PRESETS, type SpatialAccent } from '@/types';
import {
  FieldGroup,
  FieldRow,
  SectionHeader,
  SectionLabel,
} from '../components/SettingsSectionPrimitives';

export function AppearanceSection() {
  const accent = useSettingsStore((s) => s.settings.accent ?? '#2e91ff');
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
              onChange={(value) =>
                withViewTransition(() => {
                  setTheme(value);
                  updateSettings({ theme: value });
                })
              }
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
