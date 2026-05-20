#!/usr/bin/env node
/**
 * Generate docs/CAPABILITY_MATRIX.md from src/lib/shared/capabilities.ts.
 * Run with `--check` to fail when the doc is stale (CI gate).
 *
 * Pure-Node ESM (no tsx dependency required at CI-time) — extracts the
 * CAPABILITIES literal by parsing the TS source as text. Brittle to
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

// Extract the CAPABILITIES object body. Each row is one TS object literal on
// a single line; we tolerate trailing commas and quoted/unquoted notes.
const start = source.indexOf('export const CAPABILITIES');
if (start === -1) throw new Error('CAPABILITIES export not found in source');
const bodyStart = source.indexOf('{', start);
let depth = 0;
let bodyEnd = -1;
for (let i = bodyStart; i < source.length; i++) {
  const ch = source[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) { bodyEnd = i; break; }
  }
}
if (bodyEnd === -1) throw new Error('Unable to find end of CAPABILITIES literal');
const body = source.slice(bodyStart + 1, bodyEnd);

const rowRegex = /['"]([\w.]+)['"]\s*:\s*\{\s*label:\s*['"]([^'"]+)['"]\s*,\s*web:\s*(true|false)\s*,\s*desktop:\s*(true|false)\s*(?:,\s*notes:\s*['"]([^'"]+)['"]\s*)?\}/g;
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
${rows
  .map((r) => `| ${r.label} | ${yesNo(r.web)} | ${yesNo(r.desktop)} | ${r.notes} |`)
  .join('\n')}

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
