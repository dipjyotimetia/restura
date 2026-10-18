/**
 * Cross-era diff and Markdown/JSON rendering for the MCP conformance report
 * (#911). Pure; imports only types from the engine (no runtime cycle).
 */
import type { McpConformanceFinding, McpConformanceReport, McpEraResult } from './mcp-conformance';

export interface McpNamedChange {
  name: string;
  /** Which descriptor fields differ (description, inputSchema, outputSchema, annotations, ...). */
  fields: string[];
}

export interface McpListingDiff {
  onlyLegacy: string[];
  onlyModern: string[];
  changed: McpNamedChange[];
}

export interface McpEraDiff {
  protocolVersion: { legacy?: string; modern?: string };
  serverInfo: { legacy?: string; modern?: string; differs: boolean };
  capabilities: { onlyLegacy: string[]; onlyModern: string[]; changed: string[] };
  tools: McpListingDiff;
  resources: McpListingDiff;
  prompts: McpListingDiff;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Flatten nested capability objects to dotted leaf paths -> value. */
function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}) {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

function diffListing<T extends object>(
  legacy: T[],
  modern: T[],
  key: (item: T) => string,
  fields: (item: T) => Record<string, unknown>
): McpListingDiff {
  const l = new Map(legacy.map((i) => [key(i), i]));
  const m = new Map(modern.map((i) => [key(i), i]));
  const changed: McpNamedChange[] = [];
  for (const [name, li] of l) {
    const mi = m.get(name);
    if (!mi) continue;
    const lf = fields(li);
    const mf = fields(mi);
    const differing = [...new Set([...Object.keys(lf), ...Object.keys(mf)])]
      .filter((f) => !deepEqual(lf[f], mf[f]))
      .sort();
    if (differing.length > 0) changed.push({ name, fields: differing });
  }
  return {
    onlyLegacy: [...l.keys()].filter((k) => !m.has(k)).sort(),
    onlyModern: [...m.keys()].filter((k) => !l.has(k)).sort(),
    changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const serverLabel = (r: McpEraResult) =>
  r.serverInfo?.name || r.serverInfo?.version
    ? `${r.serverInfo?.name ?? '?'}@${r.serverInfo?.version ?? '?'}`
    : undefined;

/**
 * Diff legacy vs modern. Returns null unless BOTH eras connected (a missing
 * era is reported by its own `era.unsupported` / `era.connect-failed` finding).
 * Produces cross-era findings: capability/listing divergence is a warning
 * (servers may legitimately differ, but clients on the other era lose features),
 * a server name/version mismatch is a warning.
 */
export function computeMcpEraDiff(
  eras: McpEraResult[]
): { diff: McpEraDiff; findings: McpConformanceFinding[] } | null {
  const legacy = eras.find((e) => e.era === 'legacy' && e.status === 'ok');
  const modern = eras.find((e) => e.era === 'modern' && e.status === 'ok');
  if (!legacy || !modern) return null;

  const lc = flatten(legacy.capabilities);
  const mc = flatten(modern.capabilities);
  const capabilities = {
    onlyLegacy: Object.keys(lc)
      .filter((k) => !(k in mc))
      .sort(),
    onlyModern: Object.keys(mc)
      .filter((k) => !(k in lc))
      .sort(),
    changed: Object.keys(lc)
      .filter((k) => k in mc && !deepEqual(lc[k], mc[k]))
      .sort(),
  };
  const ls = serverLabel(legacy);
  const ms = serverLabel(modern);
  const diff: McpEraDiff = {
    protocolVersion: {
      ...(legacy.protocolVersion ? { legacy: legacy.protocolVersion } : {}),
      ...(modern.protocolVersion ? { modern: modern.protocolVersion } : {}),
    },
    serverInfo: {
      ...(ls ? { legacy: ls } : {}),
      ...(ms ? { modern: ms } : {}),
      differs: ls !== ms,
    },
    capabilities,
    tools: diffListing(
      legacy.listing.tools,
      modern.listing.tools,
      (t) => t.name,
      (t) => ({
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      })
    ),
    resources: diffListing(
      legacy.listing.resources,
      modern.listing.resources,
      (r) => r.uri,
      (r) => ({ name: r.name, mimeType: r.mimeType })
    ),
    prompts: diffListing(
      legacy.listing.prompts,
      modern.listing.prompts,
      (p) => p.name,
      (p) => ({ description: p.description, arguments: p.arguments })
    ),
  };

  const findings: McpConformanceFinding[] = [];
  const warn = (code: string, message: string, subject?: string) =>
    findings.push({
      code,
      severity: 'warning',
      era: 'cross-era',
      message,
      ...(subject ? { subject } : {}),
    });
  if (diff.serverInfo.differs) {
    warn(
      'diff.server-info',
      `serverInfo differs between eras (legacy ${ls ?? 'none'} vs modern ${ms ?? 'none'})`
    );
  }
  for (const k of capabilities.onlyLegacy)
    warn('diff.capability', `Capability "${k}" only advertised in the legacy era`, k);
  for (const k of capabilities.onlyModern)
    warn('diff.capability', `Capability "${k}" only advertised in the modern era`, k);
  for (const k of capabilities.changed)
    warn('diff.capability', `Capability "${k}" has different values between eras`, k);
  for (const [kind, d] of [
    ['tool', diff.tools],
    ['resource', diff.resources],
    ['prompt', diff.prompts],
  ] as const) {
    for (const n of d.onlyLegacy)
      warn(`diff.${kind}`, `${kind} "${n}" only listed in the legacy era`, n);
    for (const n of d.onlyModern)
      warn(`diff.${kind}`, `${kind} "${n}" only listed in the modern era`, n);
    for (const c of d.changed) {
      warn(
        `diff.${kind}`,
        `${kind} "${c.name}" differs between eras (${c.fields.join(', ')})`,
        c.name
      );
    }
  }
  return { diff, findings };
}

// ---------- export ----------

export function conformanceReportToJson(report: McpConformanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function esc(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function listLine(label: string, names: string[]): string[] {
  return names.length > 0 ? [`- ${label}: ${names.map((n) => `\`${n}\``).join(', ')}`] : [];
}

function renderListingDiff(title: string, d: McpListingDiff): string[] {
  if (d.onlyLegacy.length + d.onlyModern.length + d.changed.length === 0) {
    return [`- ${title}: identical`];
  }
  return [
    `- ${title}:`,
    ...listLine('  - only legacy', d.onlyLegacy),
    ...listLine('  - only modern', d.onlyModern),
    ...d.changed.map((c) => `  - changed \`${c.name}\`: ${c.fields.join(', ')}`),
  ];
}

const ICON = { error: 'ERROR', warning: 'WARN', info: 'INFO' } as const;

/** Render the report as Markdown (deterministic given the report). */
export function conformanceReportToMarkdown(report: McpConformanceReport): string {
  const out: string[] = [];
  out.push('# MCP conformance report', '');
  out.push(`- Target: \`${report.target || 'unknown'}\``);
  out.push(`- Generated: ${report.generatedAt}`);
  out.push(
    `- Sample calls: ${report.options.sampleCalls}${
      report.options.approvedTools.length > 0
        ? ` (approved: ${report.options.approvedTools.join(', ')})`
        : ''
    }`
  );
  out.push(
    `- Result: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.info} note(s)`,
    ''
  );

  out.push(
    '## Eras',
    '',
    '| Era | Status | Protocol version | Server | Tools | Resources | Prompts |'
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of report.eras) {
    out.push(
      `| ${e.era} | ${e.status} | ${e.protocolVersion ?? '-'} | ${esc(serverLabel(e) ?? '-')} | ${e.listing.tools.length} | ${e.listing.resources.length} | ${e.listing.prompts.length} |`
    );
  }
  out.push('');

  out.push('## Diff (legacy vs modern)', '');
  if (!report.diff) {
    out.push('_Not comparable: both eras must connect._', '');
  } else {
    const d = report.diff;
    out.push(
      `- Protocol version: ${d.protocolVersion.legacy ?? '-'} vs ${d.protocolVersion.modern ?? '-'}`
    );
    out.push(
      `- Server info: ${d.serverInfo.differs ? `differs (${d.serverInfo.legacy ?? '-'} vs ${d.serverInfo.modern ?? '-'})` : 'identical'}`
    );
    const c = d.capabilities;
    if (c.onlyLegacy.length + c.onlyModern.length + c.changed.length === 0) {
      out.push('- Capabilities: identical');
    } else {
      out.push('- Capabilities:');
      out.push(...listLine('  - only legacy', c.onlyLegacy));
      out.push(...listLine('  - only modern', c.onlyModern));
      out.push(...listLine('  - changed', c.changed));
    }
    out.push(...renderListingDiff('Tools', d.tools));
    out.push(...renderListingDiff('Resources', d.resources));
    out.push(...renderListingDiff('Prompts', d.prompts), '');
  }

  out.push('## Findings', '');
  if (report.findings.length === 0) {
    out.push('No findings.', '');
  } else {
    out.push('| Severity | Era | Code | Subject | Message |', '| --- | --- | --- | --- | --- |');
    for (const f of report.findings) {
      out.push(
        `| ${ICON[f.severity]} | ${f.era} | \`${f.code}\` | ${esc(f.subject ?? '')} | ${esc(f.message)} |`
      );
    }
    out.push('');
  }

  const sampled = report.eras.filter((e) => e.samples.length > 0);
  if (sampled.length > 0) {
    out.push('## Sample calls', '');
    for (const e of sampled) {
      out.push(
        `### ${e.era}`,
        '',
        '| Tool | Status | outputSchema | Note |',
        '| --- | --- | --- | --- |'
      );
      for (const s of e.samples) {
        out.push(
          `| ${esc(s.tool)} | ${s.status} | ${s.outputSchema ?? '-'} | ${esc(s.reason ?? '')} |`
        );
      }
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}
