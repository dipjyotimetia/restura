import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function attr(html: string, selector: RegExp, attribute: string): string {
  const match = html.match(selector);
  if (!match) throw new Error(`Could not find ${attribute} for ${selector}`);

  const value = match[0].match(new RegExp(`${attribute}="([^"]+)"`));
  if (!value?.[1]) throw new Error(`Could not read ${attribute} for ${selector}`);
  return value[1];
}

describe('public web metadata', () => {
  it('cache-busts every Restura app icon from one brand revision', () => {
    const index = read('index.html');
    const privacy = read('public/privacy.html');
    const manifest = JSON.parse(read('public/manifest.json')) as {
      icons: Array<{ src: string }>;
    };

    const iconUrls = [
      attr(index, /<link[^>]+rel="icon"[^>]*>/, 'href'),
      attr(index, /<link[^>]+rel="apple-touch-icon"[^>]*>/, 'href'),
      attr(privacy, /<link[^>]+rel="icon"[^>]*>/, 'href'),
      ...manifest.icons.map(({ src }) => src),
    ];

    const revisions = iconUrls.map((url) =>
      new URL(url, 'https://restura.dev').searchParams.get('v')
    );
    expect(revisions.every(Boolean)).toBe(true);
    expect(new Set(revisions).size).toBe(1);
  });

  it('describes the complete product offering in metadata and structured data', () => {
    const index = read('index.html');
    const description = attr(index, /<meta[^>]+name="description"[^>]*>/, 'content');
    const jsonLd = attr(
      index,
      /<script[^>]+type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/,
      'type'
    );
    const structuredData = JSON.parse(
      index.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''
    ) as { '@graph': Array<{ '@type': string; logo?: string }> };

    expect(description).toContain('Socket.IO, SSE, Kafka, MQTT, and MCP');
    expect(jsonLd).toBe('application/ld+json');
    expect(structuredData['@graph']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ '@type': 'Organization', logo: 'https://restura.dev/icon.svg' }),
        expect.objectContaining({ '@type': 'SoftwareApplication' }),
      ])
    );
  });
});
