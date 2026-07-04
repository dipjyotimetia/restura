/**
 * Restura routing-R brand mark. Geometry + cobalt gradient are copied from
 * `src/components/shared/lib/brandMark.json` — the extension is a standalone
 * build and can't import from `src/`, so the values are inlined (mirrors how
 * `RequestList` inlines the protocol colors). Keep in sync if the JSON changes.
 */
export function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
      className="rc-header__mark"
    >
      <defs>
        <linearGradient
          id="rcBrandGrad"
          x1="0"
          y1="0"
          x2="0"
          y2="96"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3a7ee0" />
          <stop offset="1" stopColor="#184cc0" />
        </linearGradient>
      </defs>
      <g stroke="url(#rcBrandGrad)" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round">
        <path d="M34 23 V73" />
        <path d="M34 23 H49 a14 14 0 0 1 0 28 H34" />
        <path d="M45 51 L64 73" />
      </g>
      <circle cx={65} cy={74} r={2.6} fill="url(#rcBrandGrad)" />
    </svg>
  );
}
