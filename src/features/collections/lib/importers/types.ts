import type { Collection, Environment, HttpMethod } from '@/types';

/**
 * A non-fatal observation from an importer. The collection is still usable;
 * these surface in the UI so users know what was lost or downgraded.
 */
export type ImportWarning =
  | { kind: 'unrecognized-body'; requestName: string }
  | { kind: 'unrecognized-script-type'; scriptType: string; requestName: string }
  | { kind: 'unsupported-auth'; authType: string; requestName: string }
  | { kind: 'unsupported-method'; method: string; requestName: string }
  | { kind: 'unknown-dynamic-var'; varName: string; count: number }
  | { kind: 'bruno-syntax'; pattern: string; requestName: string }
  | { kind: 'platform-unsupported'; feature: string; requestName: string }
  | { kind: 'schema-version'; format: string; version: string; note: string };

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
]);

/**
 * Coerce a source-format method string into the canonical `HttpMethod` union.
 * Real collections carry methods Restura can't send (PURGE, PROPFIND,
 * TRACE…); without coercion they'd fail the import validation gate and sink
 * the whole import. Out-of-union methods downgrade to GET with a warning so
 * the rest of the collection still lands (partial-import philosophy).
 */
export function coerceHttpMethod(
  raw: string | undefined,
  requestName: string,
  warnings?: ImportWarning[]
): HttpMethod {
  const method = (raw ?? 'GET').toUpperCase();
  if (HTTP_METHODS.has(method)) return method as HttpMethod;
  warnings?.push({ kind: 'unsupported-method', method, requestName });
  return 'GET';
}

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
export function summarizeWarnings(
  warnings: ImportWarning[]
): Array<{ kind: string; count: number; sample: string }> {
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
    case 'unsupported-method':
      return `Method "${w.method}" not supported — "${w.requestName}" imported as GET`;
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
