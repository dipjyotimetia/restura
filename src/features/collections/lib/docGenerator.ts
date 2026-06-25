/**
 * Generates human-readable API documentation from a collection.
 *
 * Walks the collection tree into a backend-agnostic DocModel, then renders
 * either Markdown (for export / README embedding) or a self-contained HTML
 * page (for the in-app viewer and offline sharing). HTML is built here with
 * explicit escaping rather than via a Markdown library — no extra dependency
 * and no untrusted-HTML surface.
 */
import type { Collection, CollectionItem, KeyValue, Request } from '@/types';

export interface DocParam {
  name: string;
  value: string;
  description?: string;
}

export interface DocOperation {
  id: string;
  /** Folder path leading to this request, e.g. "Users / Admin". */
  path: string;
  name: string;
  /** HTTP method, or the protocol name uppercased for non-HTTP requests. */
  method: string;
  protocol: Request['type'];
  url: string;
  description?: string;
  headers: DocParam[];
  params: DocParam[];
  bodyType?: string;
  body?: string;
  authType: string;
}

export interface DocModel {
  title: string;
  description?: string;
  operations: DocOperation[];
}

function enabledKeyValues(list: KeyValue[] | undefined): DocParam[] {
  return (list ?? [])
    .filter((kv) => kv.enabled && kv.key)
    .map((kv) => ({
      name: kv.key,
      value: kv.secret ? '••••••' : kv.value,
      ...(kv.description ? { description: kv.description } : {}),
    }));
}

function operationFromRequest(req: Request, path: string): DocOperation {
  const description = (req as { description?: string }).description;
  const base = {
    id: req.id,
    path,
    name: req.name,
    protocol: req.type,
    url: 'url' in req ? req.url : '',
    authType: 'auth' in req && req.auth ? req.auth.type : 'none',
    ...(description ? { description } : {}),
  };

  if (req.type === 'http') {
    const op: DocOperation = {
      ...base,
      method: req.method,
      headers: enabledKeyValues(req.headers),
      params: enabledKeyValues(req.params),
    };
    if (req.body && req.body.type !== 'none') {
      op.bodyType = req.body.type;
      if (req.body.raw) op.body = req.body.raw;
    }
    return op;
  }

  // Non-HTTP protocols: surface what's broadly available without per-protocol
  // special-casing. Method column shows the protocol so the table reads well.
  return {
    ...base,
    method: req.type.toUpperCase(),
    headers: 'headers' in req ? enabledKeyValues(req.headers) : [],
    params: 'params' in req ? enabledKeyValues(req.params) : [],
  };
}

export function buildDocModel(collection: Collection): DocModel {
  const operations: DocOperation[] = [];

  const walk = (items: CollectionItem[] | undefined, path: string) => {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'folder') {
        walk(item.items, path ? `${path} / ${item.name}` : item.name);
      } else if (item.type === 'request' && item.request) {
        operations.push(operationFromRequest(item.request, path));
      }
    }
  };
  walk(collection.items, '');

  const model: DocModel = {
    title: collection.name,
    operations,
  };
  if (collection.description) model.description = collection.description;
  return model;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function paramTable(rows: DocParam[]): string {
  const lines = ['| Name | Value | Description |', '| --- | --- | --- |'];
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${r.value || '—'} | ${r.description ?? ''} |`);
  }
  return lines.join('\n');
}

export function docModelToMarkdown(model: DocModel): string {
  const out: string[] = [`# ${model.title}`, ''];
  if (model.description) out.push(model.description, '');

  if (model.operations.length === 0) {
    out.push('_No requests in this collection._', '');
    return out.join('\n');
  }

  out.push('## Endpoints', '');
  for (const op of model.operations) {
    const heading = op.path ? `${op.path} / ${op.name}` : op.name;
    out.push(`### ${op.method} — ${heading}`, '');
    if (op.description) out.push(`> ${op.description}`, '');
    out.push('```', `${op.method} ${op.url}`, '```', '');
    if (op.headers.length > 0) out.push('**Headers**', '', paramTable(op.headers), '');
    if (op.params.length > 0) out.push('**Query parameters**', '', paramTable(op.params), '');
    if (op.body) {
      out.push(`**Body** (\`${op.bodyType}\`)`, '', '```', op.body, '```', '');
    } else if (op.bodyType) {
      out.push(`**Body:** \`${op.bodyType}\``, '');
    }
    if (op.authType !== 'none') out.push(`**Auth:** \`${op.authType}\``, '');
    out.push('---', '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// HTML (self-contained)
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlParamTable(rows: DocParam[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td><code>${escapeHtml(r.name)}</code></td><td>${escapeHtml(r.value || '—')}</td><td>${escapeHtml(r.description ?? '')}</td></tr>`
    )
    .join('');
  return `<table><thead><tr><th>Name</th><th>Value</th><th>Description</th></tr></thead><tbody>${body}</tbody></table>`;
}

const HTML_STYLES = `
:root { color-scheme: light dark; }
body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 2rem; max-width: 920px; margin-inline: auto; color: #1a1a1a; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #121212; } code, pre { background: #1e1e1e !important; } th { background: #1e1e1e !important; } }
h1 { font-size: 1.8rem; } h3 { margin-top: 2.2rem; border-top: 1px solid #8884; padding-top: 1.2rem; }
code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f6f6f6; padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0.6rem 0; font-size: 0.92em; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border: 1px solid #8883; vertical-align: top; }
th { background: #f0f0f0; }
.method { font-weight: 700; font-family: ui-monospace, monospace; }
.path { color: #888; font-weight: 400; }
.toc a { display: block; padding: 0.15rem 0; text-decoration: none; color: inherit; }
.toc a:hover { text-decoration: underline; }
`;

export function docModelToHtml(model: DocModel): string {
  const sections: string[] = [];
  const toc: string[] = [];

  model.operations.forEach((op, i) => {
    const anchor = `op-${i}`;
    const heading = op.path ? `${op.path} / ${op.name}` : op.name;
    toc.push(
      `<a href="#${anchor}"><span class="method">${escapeHtml(op.method)}</span> ${escapeHtml(heading)}</a>`
    );

    const parts: string[] = [
      `<h3 id="${anchor}"><span class="method">${escapeHtml(op.method)}</span> ${escapeHtml(op.name)} <span class="path">${escapeHtml(op.path)}</span></h3>`,
    ];
    if (op.description) parts.push(`<p>${escapeHtml(op.description)}</p>`);
    parts.push(`<pre><code>${escapeHtml(op.method)} ${escapeHtml(op.url)}</code></pre>`);
    if (op.headers.length > 0) parts.push('<h4>Headers</h4>', htmlParamTable(op.headers));
    if (op.params.length > 0) parts.push('<h4>Query parameters</h4>', htmlParamTable(op.params));
    if (op.body) {
      parts.push(
        `<h4>Body <code>${escapeHtml(op.bodyType ?? '')}</code></h4>`,
        `<pre><code>${escapeHtml(op.body)}</code></pre>`
      );
    } else if (op.bodyType) {
      parts.push(`<p><strong>Body:</strong> <code>${escapeHtml(op.bodyType)}</code></p>`);
    }
    if (op.authType !== 'none') {
      parts.push(`<p><strong>Auth:</strong> <code>${escapeHtml(op.authType)}</code></p>`);
    }
    sections.push(parts.join('\n'));
  });

  const desc = model.description ? `<p>${escapeHtml(model.description)}</p>` : '';
  const tocBlock = toc.length > 0 ? `<nav class="toc"><h2>Endpoints</h2>${toc.join('')}</nav>` : '';
  const body =
    model.operations.length === 0
      ? '<p><em>No requests in this collection.</em></p>'
      : `${tocBlock}${sections.join('\n')}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)} — API docs</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<h1>${escapeHtml(model.title)}</h1>
${desc}
${body}
</body>
</html>`;
}
