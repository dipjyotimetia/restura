'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { SpatialAccent } from '@/types';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const COBALT_FALLBACK: Rgb = { r: 77, g: 159, b: 255 };

function hexToRgb(hex: string): Rgb {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return COBALT_FALLBACK;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return COBALT_FALLBACK;
  return { r, g, b };
}

function rgbaString({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Alpha tables paired with the `--sp-accent-glow-*` CSS variable names.
// Dark surfaces eat luminance — pump alphas slightly to keep focus rings
// and accent glows visible at the same perceived intensity.
const ALPHAS_LIGHT = [
  ['--sp-accent-glow-88', 0.53],
  ['--sp-accent-glow-55', 0.33],
  ['--sp-accent-glow-33', 0.20],
  ['--sp-accent-glow-26', 0.15],
  ['--sp-accent-glow-15', 0.08],
] as const;

const ALPHAS_DARK = [
  ['--sp-accent-glow-88', 0.65],
  ['--sp-accent-glow-55', 0.40],
  ['--sp-accent-glow-33', 0.25],
  ['--sp-accent-glow-26', 0.18],
  ['--sp-accent-glow-15', 0.10],
] as const;

/**
 * Watches useSettingsStore.settings.accent and the resolved theme; writes the
 * corresponding Spatial Depth accent CSS variables to :root. The glow alpha
 * curve is tuned per theme so dark mode doesn't dim focus rings after an
 * accent change.
 */
export function AccentProvider({ children }: { children: React.ReactNode }) {
  const accent = useSettingsStore((s) => s.settings.accent) ?? ('#4d9fff' as SpatialAccent);
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    const root = document.documentElement;
    const rgb = hexToRgb(accent);
    const alphas = resolvedTheme === 'dark' ? ALPHAS_DARK : ALPHAS_LIGHT;
    root.style.setProperty('--sp-accent', accent);
    for (const [name, alpha] of alphas) {
      root.style.setProperty(name, rgbaString(rgb, alpha));
    }
  }, [accent, resolvedTheme]);

  return <>{children}</>;
}
