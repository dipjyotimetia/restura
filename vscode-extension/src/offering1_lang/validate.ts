import type { ZodType } from 'zod';
import {
  httpRequestSchema,
  grpcRequestSchema,
  graphqlRequestSchema,
  websocketRequestSchema,
} from '../../../src/lib/opencollection/schemas';
import { escapeRegExp } from '../../../src/lib/shared/escapeRegExp';
import { classifyOcFile, type OcRequestType } from '../workspace/collectionDetector';

/** A single schema violation, located against the source text (0-based line). */
export interface RequestDiagnostic {
  message: string;
  /** 0-based line in the source document. */
  line: number;
  /** Dotted Zod path, for the message detail (e.g. `http.method`). */
  pathLabel: string;
}

const SCHEMA_BY_TYPE: Record<OcRequestType, ZodType> = {
  http: httpRequestSchema,
  grpc: grpcRequestSchema,
  graphql: graphqlRequestSchema,
  websocket: websocketRequestSchema,
};

/**
 * Validate one OpenCollection YAML document against its per-request element
 * schema. Pure (no vscode dependency) so it can be unit-tested directly.
 *
 * Only **request** files are validated here — root `opencollection.{yml,yaml}`
 * files are owned by the JSON-Schema `yamlValidation` contribution to avoid
 * double-flagging. Non-request / non-collection files return `[]`.
 *
 * YAML syntax errors are intentionally NOT reported here: a file that won't
 * parse can't be classified as a request, and the editor's YAML grammar (or
 * redhat.vscode-yaml) already surfaces syntax errors.
 */
export function validateOcDocument(filePath: string, text: string): RequestDiagnostic[] {
  const classified = classifyOcFile(filePath, text);
  if (classified.kind !== 'request') return [];

  const result = SCHEMA_BY_TYPE[classified.type].safeParse(classified.doc);
  if (result.success) return [];

  const lines = text.split('\n');
  return result.error.issues.map((issue) => {
    const pathLabel = issue.path.map((p) => String(p)).join('.') || '(root)';
    return {
      message: issue.message,
      line: findLineForPath(lines, issue.path),
      pathLabel,
    };
  });
}

/**
 * Best-effort: locate the source line for a Zod issue path by walking key
 * segments through the (indented) YAML text. Falls back to line 0 when a
 * segment can't be located (e.g. the key is missing — which is often the very
 * reason for the issue).
 */
function findLineForPath(lines: string[], pathSegments: ReadonlyArray<PropertyKey>): number {
  let searchFrom = 0;
  let best = 0;
  for (const seg of pathSegments) {
    if (typeof seg !== 'string') continue; // array index / symbol — keep the parent's line
    const re = new RegExp(`^\\s*${escapeRegExp(seg)}\\s*:`);
    let found = -1;
    for (let i = searchFrom; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && re.test(line)) {
        found = i;
        break;
      }
    }
    if (found === -1) break;
    best = found;
    searchFrom = found + 1;
  }
  return best;
}
