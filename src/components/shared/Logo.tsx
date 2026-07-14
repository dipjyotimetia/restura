import * as React from 'react';
import { cn } from '@/lib/shared/utils';
import { BRAND_MARK } from './lib/brandMark';

interface LogoProps {
  /** Pixel size of the square mark. Defaults to 32. */
  size?: number;
  /** Show the "Restura" wordmark to the right of the mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * Restura brand mark — the "Routing R" on a rounded cobalt tile.
 *
 * Geometry comes from {@link BRAND_MARK} (the single source of truth shared with
 * the static favicon/app-icon SVGs and the macOS tray template), so the in-app
 * mark can never drift from the favicon. The fill is the fixed brand gradient
 * (single-hue cobalt) rather than `--sp-accent`, so the mark stays brand-cobalt
 * even when the user picks a different accent preset. The tile carries a
 * restrained neutral drop shadow (no accent glow) so it reads as a machined
 * object rather than a lit-up badge.
 *
 * The gradient is keyed by a unique React id so multiple logos can coexist on a
 * page without DOM-id collisions.
 */
export function Logo({ size = 32, withWordmark = false, className }: LogoProps) {
  const reactId = React.useId();
  const gradId = `logo-grad-${reactId}`;
  const { viewBox, paths, strokeWidth, node, gradient, tileRadiusRatio, highlight } = BRAND_MARK;
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
          boxShadow: '0 1px 2px rgba(9, 16, 40, 0.28), 0 3px 10px rgba(9, 16, 40, 0.16)',
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient.from} />
            <stop offset="100%" stopColor={gradient.to} />
          </linearGradient>
        </defs>
        <rect width={viewBox} height={viewBox} rx={rx} fill={`url(#${gradId})`} />
        {/* Inner highlight — sells the "glass tile" feel. */}
        <rect
          x={highlight.inset}
          y={highlight.inset}
          width={viewBox - 2 * highlight.inset}
          height={viewBox - 2 * highlight.inset}
          rx={Math.max(rx - highlight.inset, 0)}
          fill="none"
          stroke={`rgba(255,255,255,${highlight.opacity})`}
          strokeWidth={highlight.strokeWidth}
        />
        {/* Routing R — stem, top bowl, diagonal leg landing on a node. Crisp
            geometric strokes (not a typeface) so it stays legible at 16px and
            below, where the node simply melts into a clean R. */}
        {paths.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="#ffffff"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* Endpoint node — the request "lands here". */}
        <circle cx={node.cx} cy={node.cy} r={node.r} fill="#ffffff" />
      </svg>
      {withWordmark && (
        <span className="text-sp-13 font-bold tracking-tight text-sp-text leading-none">
          Restura
        </span>
      )}
    </span>
  );
}
