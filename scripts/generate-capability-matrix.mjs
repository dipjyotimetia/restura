#!/usr/bin/env node
/**
 * Generate docs/CAPABILITY_MATRIX.md from src/lib/shared/capabilities.ts.
 * Run with `--check` to fail when the doc is stale (CI gate).
 *
 * Pure-Node ESM (no tsx dependency required at CI-time) — extracts the
 * capability rows by parsing the TS sources (capabilities.ts and the
 * per-area modules it spreads from ./capabilities/) as text. Brittle to
 * formatting churn; the inverse-quality is that there are no build
 * dependencies to maintain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'src/lib/shared/capabilities.ts');
const docPath = path.join(repoRoot, 'docs/CAPABILITY_MATRIX.md');

const source = fs.readFileSync(sourcePath, 'utf8');

// Return the text between the braces of the first `{` after `marker`.
function extractLiteralBody(text, marker, file) {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`${marker} not found in ${file}`);
  const bodyStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(bodyStart + 1, i);
    }
  }
  throw new Error(`Unable to find end of ${marker} literal in ${file}`);
}

// The rows live in per-area modules under src/lib/shared/capabilities/, and
// capabilities.ts composes them as `const ALL_CAPABILITIES = { ...A, ...B }`.
// Resolve each spread to its `import { A } from './capabilities/<area>'`
// module and concatenate the area literals in spread order, which is the row
// order of the matrix.
const composed = extractLiteralBody(source, 'const ALL_CAPABILITIES', sourcePath);
const spreads = [...composed.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
if (spreads.length === 0) throw new Error('No capability area spreads found in source');
const body = spreads
  .map((name) => {
    const importMatch = source.match(
      new RegExp(`import\\s*\\{\\s*${name}\\s*\\}\\s*from\\s*['"](\\./capabilities/[\\w-]+)['"]`)
    );
    if (!importMatch) throw new Error(`No ./capabilities/* import found for ${name}`);
    const areaPath = path.join(path.dirname(sourcePath), `${importMatch[1]}.ts`);
    const areaSource = fs.readFileSync(areaPath, 'utf8');
    return extractLiteralBody(areaSource, `export const ${name}`, areaPath);
  })
  .join('\n');

// Multi-line tolerant — Prettier wraps rows that carry a `notes` field onto
// 4–5 lines. The previous single-line regex silently dropped those rows.
// `\s` already matches newlines, but the trailing comma after `notes` is
// what Prettier inserts on wrap, so we accept an optional comma there too.
const rowRegex =
  /['"]([\w.]+)['"]\s*:\s*\{\s*label:\s*['"]([^'"]+)['"]\s*,\s*web:\s*(true|false)\s*,\s*desktop:\s*(true|false)\s*(?:,\s*notes:\s*['"]([^'"]+)['"]\s*,?\s*)?\}/g;
const rows = [];
let match;
while ((match = rowRegex.exec(body)) !== null) {
  rows.push({
    name: match[1],
    label: match[2],
    web: match[3] === 'true',
    desktop: match[4] === 'true',
    notes: match[5] ?? '',
  });
}

if (rows.length === 0) {
  throw new Error('Parsed zero capability rows; regex likely needs adjustment');
}

const yesNo = (b) => (b ? '✅' : '❌');
const doc = `# Restura Capability Matrix

> **Generated** from \`src/lib/shared/capabilities.ts\`. Do not edit by hand.
> CI fails if this file is stale; regenerate with \`npm run capabilities:matrix\`.

Restura ships as both a Cloudflare Pages SPA (web) and an Electron desktop
app from a single React renderer. Some features depend on capabilities the
browser sandbox doesn't expose (raw sockets, OS keychain, filesystem). This
table documents what works where so you can see the asymmetry at a glance
rather than discover it experimentally.

| Capability | Web | Desktop | Notes |
| --- | :-: | :-: | --- |
${rows.map((r) => `| ${r.label} | ${yesNo(r.web)} | ${yesNo(r.desktop)} | ${r.notes} |`).join('\n')}

---

To gate UI on a capability:

\`\`\`tsx
import { CapabilityBadge } from '@/components/shared/CapabilityBadge';
<CapabilityBadge feature="http.mtls" />
\`\`\`

To gate logic:

\`\`\`ts
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
if (isCapableHere('http.proxy.socks', isElectron())) {
  // ...
}
\`\`\`
`;

const check = process.argv.includes('--check');
if (check) {
  const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  if (current !== doc) {
    console.error('CAPABILITY_MATRIX.md is stale. Run `npm run capabilities:matrix` to update.');
    process.exit(1);
  }
  console.log('CAPABILITY_MATRIX.md is up to date.');
} else {
  fs.writeFileSync(docPath, doc);
  console.log(`Wrote ${docPath} (${rows.length} rows)`);
}
