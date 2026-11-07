import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPATIAL_ACCENT_PRESETS } from '@/types';

/**
 * WCAG contrast guard for the light-theme accent. `--sp-accent` is painted as
 * text (`text-sp-accent`, `text-primary`) and as the fill behind white CTA
 * labels (`.sp-cta`), so its light-mode "ink" must reach 4.5:1 against both
 * white and the raised light surface — for the default and every preset the
 * AccentProvider can write at runtime.
 */

const css = readFileSync(resolve(__dirname, 'globals.css'), 'utf8');

type Rgb = [number, number, number];
type Oklch = { l: number; c: number; h: number };

function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}
function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** OKLCH → linear sRGB (Björn Ottosson's OKLab matrices). */
function oklchToLinearRgb({ l, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearRgbToOklch([r, g, b]: Rgb): Oklch {
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function hexToOklch(hex: string): Oklch {
  const n = Number.parseInt(hex.slice(1), 16);
  const rgb: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    srgbToLinear(v / 255)
  ) as Rgb;
  return linearRgbToOklch(rgb);
}

/**
 * Map into the sRGB gamut the way CSS Color 4 does in spirit: keep L and hue,
 * reduce chroma until every channel is displayable.
 */
function toDisplayableLinear(color: Oklch): Rgb {
  let { c } = color;
  for (let i = 0; i < 200; i++) {
    const rgb = oklchToLinearRgb({ ...color, c });
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      return rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
    }
    c *= 0.97;
  }
  return oklchToLinearRgb({ ...color, c: 0 });
}

function luminance(color: Oklch): number {
  // Round-trip through 8-bit sRGB to match what is actually painted.
  const [r, g, b] = toDisplayableLinear(color).map((v) =>
    srgbToLinear(Math.round(linearToSrgb(v) * 255) / 255)
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Oklch, b: Oklch): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function parseOklch(text: string): Oklch {
  const m = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/.exec(text);
  if (!m) throw new Error(`not an oklch() value: ${text}`);
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) };
}

function lightBranch(token: string): string {
  const m = new RegExp(`${token}:\\s*light-dark\\((oklch\\([^)]*\\))`).exec(css);
  if (!m?.[1]) throw new Error(`no light-dark() light branch for ${token}`);
  return m[1];
}

const WHITE: Oklch = { l: 1, c: 0, h: 0 };
const surfaceHi = parseOklch(lightBranch('--sp-surface-hi'));

/** The lightness ceiling `--sp-accent-ink` clamps the light-mode accent to. */
function inkLightnessCeiling(): number {
  const m =
    /--sp-accent-ink:\s*light-dark\(\s*oklch\(from var\(--sp-accent\) min\(l,\s*([\d.]+)\)/.exec(
      css
    );
  if (!m?.[1])
    throw new Error('--sp-accent-ink must clamp the light accent: oklch(from … min(l, N) c h)');
  return Number(m[1]);
}

function lightInk(accent: Oklch): Oklch {
  return { ...accent, l: Math.min(accent.l, inkLightnessCeiling()) };
}

describe('light-theme accent contrast (WCAG 1.4.3)', () => {
  it('the converter agrees with known values', () => {
    expect(contrast(WHITE, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 0);
    expect(hexToOklch('#ffffff').l).toBeCloseTo(1, 3);
  });

  it('the static default light accent ink passes on white and on surface-hi', () => {
    const ink = lightInk(parseOklch(lightBranch('--sp-accent')));
    expect(contrast(ink, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, surfaceHi)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SPATIAL_ACCENT_PRESETS)('runtime accent preset %s passes once clamped', (hex) => {
    const ink = lightInk(hexToOklch(hex));
    expect(contrast(ink, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, surfaceHi)).toBeGreaterThanOrEqual(4.5);
  });

  it('text, primary and CTA fills use the text-safe ink, not the raw accent', () => {
    expect(css).toMatch(/--color-sp-accent:\s*var\(--sp-accent-ink\)/);
    expect(css).toMatch(/--color-primary:\s*var\(--sp-accent-ink\)/);
    expect(css).toMatch(/\.sp-cta\s*\{\s*background:\s*var\(--sp-accent-ink\)/);
  });

  it('the raw default light accent alone would fail (guards the regression)', () => {
    const raw = parseOklch(lightBranch('--sp-accent'));
    // Documented: cobalt at L 66% is a brand tint, not a text colour.
    expect(contrast({ ...raw, l: 0.66 }, WHITE)).toBeLessThan(4.5);
  });
});
