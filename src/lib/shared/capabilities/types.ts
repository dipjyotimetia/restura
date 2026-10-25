export interface CapabilityRow {
  /** Display label for docs/UI. */
  label: string;
  /** Whether this works in the Cloudflare Pages SPA. */
  web: boolean;
  /** Whether this works in the Electron desktop build. */
  desktop: boolean;
  notes?: string;
}
