import type { Collection, Environment } from '@/types';

/**
 * A non-fatal observation from an importer. The collection is still usable;
 * these surface in the UI so users know what was lost or downgraded.
 */
export type ImportWarning =
  | { kind: 'unrecognized-body'; requestName: string }
  | { kind: 'unrecognized-script-type'; scriptType: string; requestName: string }
  | { kind: 'unsupported-auth'; authType: string; requestName: string }
  | { kind: 'unknown-dynamic-var'; varName: string; count: number }
  | { kind: 'bruno-syntax'; pattern: string; requestName: string }
  | { kind: 'platform-unsupported'; feature: string; requestName: string }
  | { kind: 'schema-version'; format: string; version: string; note: string };

/**
 * Common shape every importer returns. UI surfaces (ImportDialog) iterate
 * `warnings` and render a non-blocking review panel when any are present.
 */
export interface ImportResult {
  collection: Collection;
  /** Optional separate environments to push into useEnvironmentStore. */
  environments?: Environment[];
  warnings: ImportWarning[];
}

/**
 * Helper for building human-readable summaries of warnings, grouped by kind.
 * Used by ImportDialog and any future CLI/import telemetry.
 */
export function summarizeWarnings(warnings: ImportWarning[]): Array<{ kind: string; count: number; sample: string }> {
  const groups = new Map<string, ImportWarning[]>();
  for (const w of warnings) {
    const arr = groups.get(w.kind) ?? [];
    arr.push(w);
    groups.set(w.kind, arr);
  }
  return Array.from(groups.entries()).map(([kind, ws]) => ({
    kind,
    count: ws.length,
    sample: describeWarning(ws[0]!),
  }));
}

function describeWarning(w: ImportWarning): string {
  switch (w.kind) {
    case 'unrecognized-body':
      return `Body shape not recognized in request "${w.requestName}"`;
    case 'unrecognized-script-type':
      return `Script type "${w.scriptType}" dropped from "${w.requestName}"`;
    case 'unsupported-auth':
      return `Auth type "${w.authType}" not supported for "${w.requestName}"`;
    case 'unknown-dynamic-var':
      return `{{$${w.varName}}} referenced ${w.count}x but not implemented`;
    case 'bruno-syntax':
      return `Bruno-specific syntax "${w.pattern}" in "${w.requestName}"`;
    case 'platform-unsupported':
      return `${w.feature} not available on this platform (request: ${w.requestName})`;
    case 'schema-version':
      return `${w.format} v${w.version}: ${w.note}`;
  }
}
