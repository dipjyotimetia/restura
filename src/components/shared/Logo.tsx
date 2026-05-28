import * as React from 'react';
import { cn } from '@/lib/shared/utils';

interface LogoProps {
  /** Pixel size of the square mark. Defaults to 32. */
  size?: number;
  /** Show the "Restura" wordmark to the right of the mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * Restura brand mark — a rounded tile carrying a stylised "R".
 *
 * The fill uses `--sp-accent` so it picks up the active accent preset, and
 * the glow shadow mirrors the Spatial Depth `--sp-accent-glow-55` token so
 * the logo reads as a first-class surface in the design system.
 *
 * The internal `<symbol>` is keyed by a unique React id so multiple logos
 * can coexist on a page without DOM-id collisions.
 */
export function Logo({ size = 32, withWordmark = false, className }: LogoProps) {
  const reactId = React.useId();
  const gradId = `logo-grad-${reactId}`;

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        role="img"
        aria-label="Restura"
        style={{
          borderRadius: 8,
          boxShadow: '0 6px 18px var(--sp-accent-glow-55)',
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--sp-accent)" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill={`url(#${gradId})`} />
        {/* Inner highlight — sells the "glass tile" feel. */}
        <rect
          x="0.5"
          y="0.5"
          width="31"
          height="31"
          rx="7.5"
          fill="none"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1"
        />
        {/* Stylised R: vertical stem, top bowl, diagonal leg. Uses crisp
            geometric strokes rather than a typeface so it stays legible at
            16px and below. */}
        <path
          d="M10 8 L10 24 M10 8 L18 8 Q22 8 22 12 Q22 16 18 16 L10 16 M16 16 L22 24"
          stroke="#ffffff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      {withWordmark && (
        <span className="text-sp-13 font-bold tracking-tight text-sp-text leading-none">
          Restura
        </span>
      )}
    </span>
  );
}
