import ResizableLayout from '@/components/shared/ResizableLayout';
import { useSettingsStore } from '@/store/useSettingsStore';

const DEFAULT_SPLIT = 40;

/**
 * Streaming clients' layout: connection config (URL, headers, compose) above,
 * the live log below, with a draggable divider whose position is persisted.
 * Always stacked — the config pane is short, so side by side would waste it.
 */
export function StreamSplit({ config, log }: { config: React.ReactNode; log: React.ReactNode }) {
  const split = useSettingsStore((s) => s.settings.streamSplit);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  return (
    <ResizableLayout
      orientation="vertical"
      defaultSplit={DEFAULT_SPLIT}
      split={split ?? DEFAULT_SPLIT}
      onSplitChange={(streamSplit) => updateSettings({ streamSplit })}
      minSplit={15}
      maxSplit={75}
    >
      {config}
      {log}
    </ResizableLayout>
  );
}
