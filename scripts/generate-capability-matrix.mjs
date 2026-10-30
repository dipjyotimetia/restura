#!/usr/bin/env node
/**
 * Generate docs/CAPABILITY_MATRIX.md and the docs-site capability table partial
 * from src/lib/shared/capabilities.ts.
 * Run with `--check` to fail when either is stale (CI gate).
 *
 * Loads the real composed `CAPABILITIES` object rather than regex-parsing the
 * TS source: esbuild (already a devDependency, used for the preload bundle)
 * bundles capabilities.ts and its per-area modules in memory, and the result
 * is imported from a data: URL. The previous text parser silently dropped any
 * row whose label or notes contained a quote character.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'src/lib/shared/capabilities.ts');
const docPath = path.join(repoRoot, 'docs/CAPABILITY_MATRIX.md');
// Rendered by docs-site/.../reference/capability-matrix.mdx. The leading
// underscore keeps Starlight from publishing the partial as a page of its own.
const sitePartialPath = path.join(
  repoRoot,
  'docs-site/src/content/docs/reference/_capability-table.md'
);

const bundled = await build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});
const code = bundled.outputFiles[0].text;
const { CAPABILITIES } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
if (!CAPABILITIES || typeof CAPABILITIES !== 'object') {
  throw new Error('CAPABILITIES export not found in src/lib/shared/capabilities.ts');
}

// One table cell: a pipe would split the cell and a newline would split the
// row, so escape the former and refuse the latter.
function cell(value, name, field) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error(`${name}.${field} contains a newline`);
  return text.replaceAll('|', '\\|');
}

const rows = Object.entries(CAPABILITIES).map(([name, row]) => {
  if (typeof row.web !== 'boolean' || typeof row.desktop !== 'boolean') {
    throw new Error(`${name}: web/desktop must be booleans`);
  }
  return {
    name,
    label: cell(row.label, name, 'label'),
    web: row.web,
    desktop: row.desktop,
    notes: cell(row.notes, name, 'notes'),
  };
});

const yesNo = (b) => (b ? '✅' : '❌');
const tableRows = rows.map(
  (r) => `| ${r.label} | ${yesNo(r.web)} | ${yesNo(r.desktop)} | ${r.notes} |`
);
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
${tableRows.join('\n')}

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

// Guard: every capability must become exactly one table row. Count the rows
// actually rendered into the doc, not the input list, so a formatting bug
// that merges or splits rows fails loudly instead of shipping a short matrix.
const expected = Object.keys(CAPABILITIES).length;
const rendered = doc.split('\n').filter((line) => /^\| .* \| (✅|❌) \| (✅|❌) \| /.test(line));
if (expected === 0 || rendered.length !== expected) {
  throw new Error(
    `Capability matrix has ${rendered.length} rows but CAPABILITIES has ${expected} entries`
  );
}

const sitePartial = `<!-- Generated from src/lib/shared/capabilities.ts by \`npm run capabilities:matrix\`. Do not edit by hand. -->

| Capability | Web | Desktop | Notes |
| --- | :-: | :-: | --- |
${tableRows.join('\n')}
`;

const outputs = [
  { file: docPath, content: doc, label: 'CAPABILITY_MATRIX.md' },
  { file: sitePartialPath, content: sitePartial, label: path.relative(repoRoot, sitePartialPath) },
];

const check = process.argv.includes('--check');
if (check) {
  let stale = false;
  for (const { file, content, label } of outputs) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== content) {
      console.error(`${label} is stale. Run \`npm run capabilities:matrix\` to update.`);
      stale = true;
    } else {
      console.log(`${label} is up to date.`);
    }
  }
  if (stale) process.exit(1);
} else {
  for (const { file, content } of outputs) {
    fs.writeFileSync(file, content);
    console.log(`Wrote ${file} (${rows.length} rows)`);
  }
}
