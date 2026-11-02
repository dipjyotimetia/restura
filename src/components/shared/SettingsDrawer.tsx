/**
 * Compatibility entry point for existing renderer consumers.
 *
 * Settings is feature-owned; keep this re-export until all consumers can move
 * without forcing unrelated route work into the settings refactor.
 */

export type { SectionId, SettingsDrawerProps } from '@/features/settings/SettingsDrawer';
export { default } from '@/features/settings/SettingsDrawer';
