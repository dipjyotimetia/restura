'use client';

import * as React from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { SpatialAccent } from '@/types';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function rgbaString({ r, g, b }: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Watches useSettingsStore.settings.accent and writes the corresponding
 * Spatial Depth accent CSS variables to :root. Derives the glow alpha
 * variants from the chosen hex so the picker covers all 6 presets uniformly.
 */
export function AccentProvider({ children }: { children: React.ReactNode }) {
  const accent = useSettingsStore((s) => s.settings.accent) ?? ('#4d9fff' as SpatialAccent);

  React.useEffect(() => {
    const root = document.documentElement;
    const rgb = hexToRgb(accent);
    root.style.setProperty('--sp-accent', accent);
    root.style.setProperty('--sp-accent-glow-88', rgbaString(rgb, 0.53));
    root.style.setProperty('--sp-accent-glow-55', rgbaString(rgb, 0.33));
    root.style.setProperty('--sp-accent-glow-33', rgbaString(rgb, 0.20));
    root.style.setProperty('--sp-accent-glow-26', rgbaString(rgb, 0.15));
    root.style.setProperty('--sp-accent-glow-15', rgbaString(rgb, 0.08));
  }, [accent]);

  return <>{children}</>;
}
