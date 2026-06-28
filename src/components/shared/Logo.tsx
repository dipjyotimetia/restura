import * as React from 'react';
import { BRAND_MARK } from './lib/brandMark';
import { cn } from '@/lib/shared/utils';

interface LogoProps {
  /** Pixel size of the square mark. Defaults to 32. */
  size?: number;
  /** Show the "Restura" wordmark to the right of the mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * Restura brand mark — a constructed "R" (squared, rounded-corner bowl) on a
 * rounded tile.
 *
 * Geometry comes from {@link BRAND_MARK} (the single source of truth shared with
 * the static favicon/app-icon SVGs), so the in-app mark can never drift from the
 * favicon. The fill is the fixed brand gradient (single-hue cobalt, tonal depth)
 * rather than `--sp-accent`, so the mark stays brand-cobalt even when the user
 * picks a different accent preset.
 */
export function Logo({ size = 32, withWordmark = false, className }: LogoProps) {
  const reactId = React.useId();
  const gradId = `logo-grad-${reactId}`;
  const { viewBox, paths, strokeWidth, gradient, tileRadiusRatio } = BRAND_MARK;
  const rx = viewBox * tileRadiusRatio;

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        role="img"
        aria-label="Restura"
        style={{
          borderRadius: size * tileRadiusRatio,
          boxShadow: '0 6px 18px var(--sp-accent-glow-55)',
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={gradient.from} />
            <stop offset="100%" stopColor={gradient.to} />
          </linearGradient>
        </defs>
        <rect width={viewBox} height={viewBox} rx={rx} fill={`url(#${gradId})`} />
        {/* Constructed R: stem, squared rounded-corner bowl, and a leg that
            springs from the stem/bowl junction. Constructed strokes rather than
            a typeface so it stays legible at 16px and below, and survives in a
            single flat colour (favicon, macOS menu-bar template, app icon). */}
        {paths.map((d) => (
          <path
            key={d}
            d={d}
            stroke="#ffffff"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
      </svg>
      {withWordmark && (
        <span className="text-sp-13 font-bold tracking-tight text-sp-text leading-none">
          Restura
        </span>
      )}
    </span>
  );
}
