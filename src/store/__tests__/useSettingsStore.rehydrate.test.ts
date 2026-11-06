import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '../useSettingsStore';

/**
 * zustand only calls `migrate` on a version change, so a corrupt blob at the
 * CURRENT version reaches the store through `merge` alone — it must be
 * validated there too, field-wise, without dropping the valid fields.
 */
describe('useSettingsStore — same-version rehydrate validation', () => {
  const merge = () => {
    const fn = useSettingsStore.persist.getOptions().merge;
    if (!fn) throw new Error('settings store has no merge');
    return fn;
  };
  // Nothing in this file mutates the store, so its state is the defaults.
  const fresh = () => useSettingsStore.getState();

  it('coerces corrupt fields to defaults while keeping valid ones', () => {
    const current = fresh();
    const defaults = current.settings;
    const merged = merge()(
      {
        settings: {
          ...defaults,
          defaultTimeout: 'not-a-number',
          layoutOrientation: 'diagonal',
          maxRedirects: 3,
          theme: 'dark',
        },
      },
      current
    );
    expect(merged.settings.defaultTimeout).toBe(defaults.defaultTimeout);
    expect(merged.settings.layoutOrientation).toBe(defaults.layoutOrientation);
    expect(merged.settings.maxRedirects).toBe(3);
    expect(merged.settings.theme).toBe('dark');
    // Actions survive the merge.
    expect(typeof merged.updateSettings).toBe('function');
  });

  it('falls back to defaults for a non-object settings blob', () => {
    const current = fresh();
    const merged = merge()({ settings: 'garbage' }, current);
    expect(merged.settings).toEqual(current.settings);
  });

  it('ignores a non-object persisted state', () => {
    const current = fresh();
    expect(merge()(null, current)).toBe(current);
  });
});
