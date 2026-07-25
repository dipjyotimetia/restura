import { Sliders } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Segmented, ToggleField } from '@/components/ui/spatial';
import { withViewTransition } from '@/lib/shared/viewTransition';
import { useSettingsStore } from '@/store/useSettingsStore';
import { FieldGroup, FieldRow, SectionHeader } from '../components/SettingsSectionPrimitives';

export function GeneralSection() {
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
              onChange={(value) => {
                withViewTransition(() => {
                  setTheme(value);
                  updateSettings({ theme: value });
                });
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
              onChange={(value) => updateSettings({ layoutOrientation: value })}
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
              onChange={(value) => updateSettings({ autoSaveHistory: value })}
              ariaLabel="Auto-save history"
            />
          }
        />
      </FieldGroup>
      <FieldGroup label="Privacy">
        <FieldRow
          label="Send crash & error reports"
          hint="Helps fix bugs. Only the error message, stack, app version, and browser/OS info are sent — never request payloads, URLs, headers, or response bodies."
          control={
            <ToggleField
              checked={settings.telemetry?.errorsEnabled ?? true}
              onChange={(value) => updateSettings({ telemetry: { errorsEnabled: value } })}
              ariaLabel="Send crash and error reports"
            />
          }
        />
      </FieldGroup>
    </>
  );
}
