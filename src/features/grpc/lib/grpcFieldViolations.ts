/**
 * Map `google.rpc.BadRequest` field violations onto the gRPC request editor
 * (#941).
 *
 * A server reports a rejected field as a proto field path — AIP-193 style
 * `book.authors[0].display_name`, `labels["env"]`, sometimes `items.2.name`.
 * The request editor holds proto3 JSON, whose keys are the fields' `json_name`
 * (lowerCamelCase by default) — though the user may have typed the proto name,
 * which parsers also accept. So each path segment is resolved against both the
 * method's input descriptor (when the request has a schema) and the keys that
 * actually exist in the document, then located in the editor text with
 * jsonc-parser for markers and click-to-jump.
 */
import type { DescField, DescMessage } from '@bufbuild/protobuf';
import {
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { findNodeAtLocation, type Node, parse, parseTree } from 'jsonc-parser';
import type { GrpcSchemaSnapshot, GrpcStatusDetail } from '@/types';

/** A `google.rpc.BadRequest.FieldViolation`, flattened across every BadRequest detail. */
export interface GrpcFieldViolation {
  /** Proto field path as sent by the server, e.g. `book.authors[0].name`. */
  field: string;
  description: string;
  reason?: string;
}

/** Every BadRequest field violation in a detail list, in order. */
export function fieldViolationsOf(
  details: ReadonlyArray<GrpcStatusDetail> | undefined
): GrpcFieldViolation[] {
  const out: GrpcFieldViolation[] = [];
  for (const d of details ?? []) {
    if (d.type !== 'google.rpc.BadRequest' || !d.value || typeof d.value !== 'object') continue;
    const list = (d.value as { fieldViolations?: unknown }).fieldViolations;
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      if (!v || typeof v !== 'object') continue;
      const fv = v as { field?: unknown; description?: unknown; reason?: unknown };
      out.push({
        field: typeof fv.field === 'string' ? fv.field : '',
        description: typeof fv.description === 'string' ? fv.description : '',
        ...(typeof fv.reason === 'string' && fv.reason ? { reason: fv.reason } : {}),
      });
    }
  }
  return out;
}

export type FieldPathSegment = string | number;

/**
 * Split a violation field path into segments: `a.b[0].c` → ['a','b',0,'c'],
 * `labels["k.x"]` → ['labels','k.x'], `items.2.name` → ['items',2,'name'].
 */
export function parseFieldPath(field: string): FieldPathSegment[] {
  const out: FieldPathSegment[] = [];
  const re = /\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'([^']*)'\s*\]|\[\s*([^\]]*?)\s*\]|([^.[\]]+)/g;
  for (const m of field.matchAll(re)) {
    const [, dq, sq, bare, word] = m;
    if (dq !== undefined) out.push(dq.replace(/\\(.)/g, '$1'));
    else if (sq !== undefined) out.push(sq);
    else {
      const seg = (bare ?? word ?? '').trim();
      if (seg === '') continue;
      out.push(/^\d+$/.test(seg) ? Number(seg) : seg);
    }
  }
  return out;
}

function toJsonName(protoName: string): string {
  return protoName.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function findField(desc: DescMessage | undefined, seg: string): DescField | undefined {
  return desc?.fields.find((f) => f.name === seg || f.jsonName === seg || f.localName === seg);
}

export interface ResolvedViolationPath {
  /** JSON path into the document (keys as written, array indices as numbers). */
  path: FieldPathSegment[];
  /** False when only a prefix exists in the document (e.g. a missing field). */
  exact: boolean;
}

/**
 * Resolve proto field-path segments to the JSON path that exists in `doc`.
 * Stops at the deepest existing node when the rest is absent (a required
 * field the user left out is reported on its parent object).
 */
export function resolveViolationPath(
  segments: ReadonlyArray<FieldPathSegment>,
  doc: unknown,
  input?: DescMessage
): ResolvedViolationPath {
  const path: FieldPathSegment[] = [];
  let node: unknown = doc;
  let desc: DescMessage | undefined = input;
  let mapField: DescField | undefined; // the next segment is a key of this map
  for (const seg of segments) {
    if (mapField) {
      const key = String(seg);
      if (!isPlainObject(node) || !(key in node)) return { path, exact: false };
      path.push(key);
      node = node[key];
      desc =
        mapField.fieldKind === 'map' && mapField.mapKind === 'message'
          ? mapField.message
          : undefined;
      mapField = undefined;
      continue;
    }
    if (typeof seg === 'number') {
      if (!Array.isArray(node) || seg >= node.length) return { path, exact: false };
      path.push(seg);
      node = node[seg];
      continue; // element type = the list field's message, already in `desc`
    }
    if (!isPlainObject(node)) return { path, exact: false };
    const obj = node;
    const field = findField(desc, seg);
    const candidates = [...(field ? [field.jsonName, field.name] : []), toJsonName(seg), seg];
    const key = candidates.find((k) => k in obj);
    if (key === undefined) return { path, exact: false };
    path.push(key);
    node = obj[key];
    if (!field) {
      desc = undefined;
    } else if (field.fieldKind === 'message') {
      desc = field.message;
    } else if (field.fieldKind === 'list') {
      desc = field.listKind === 'message' ? field.message : undefined;
    } else if (field.fieldKind === 'map') {
      mapField = field;
      desc = undefined;
    } else {
      desc = undefined;
    }
  }
  return { path, exact: true };
}

export interface LocatedViolation extends GrpcFieldViolation {
  path: FieldPathSegment[];
  exact: boolean;
  /** Character range in the editor text (property key through value), or null. */
  range: { start: number; end: number } | null;
}

function rangeOf(
  root: Node,
  path: FieldPathSegment[],
  exact: boolean
): { start: number; end: number } | null {
  const node = findNodeAtLocation(root, path);
  if (!node) return null;
  // A field missing from the document is reported on its closest existing
  // ancestor; for the document root mark just the opening brace, not everything.
  if (!exact && path.length === 0) return { start: node.offset, end: node.offset + 1 };
  // Highlight `"key": value` for object members so the key is underlined too.
  const target = node.parent?.type === 'property' ? node.parent : node;
  return { start: target.offset, end: target.offset + target.length };
}

/**
 * Locate each violation in the request JSON text. Unparseable text (e.g. an
 * unresolved `{{var}}` where a value belongs) still yields a best-effort tree;
 * a violation with no locatable node gets `range: null` and stays listed.
 */
export function locateFieldViolations(
  text: string,
  violations: ReadonlyArray<GrpcFieldViolation>,
  input?: DescMessage
): LocatedViolation[] {
  // A bare `{{var}}` value isn't JSON and would derail the parse from there
  // on; swap each for a same-length number so offsets stay exact (inside a
  // string it just stays a string).
  const masked = text.replace(/\{\{[^{}]*\}\}/g, (m) => `1${'0'.repeat(m.length - 1)}`);
  const options = { allowTrailingComma: true };
  const root = parseTree(masked, [], options);
  const doc: unknown = parse(masked, [], options); // error-tolerant, like the tree
  return violations.map((v) => {
    const { path, exact } = resolveViolationPath(parseFieldPath(v.field), doc, input);
    const range = root ? rangeOf(root, path, exact) : null;
    return { ...v, path, exact, range };
  });
}

/** The method's input message descriptor from a persisted schema snapshot, if resolvable. */
export function inputDescriptorFor(
  schema: GrpcSchemaSnapshot | undefined,
  service: string,
  method: string
): DescMessage | undefined {
  if (!schema || !service || !method) return undefined;
  try {
    const registry =
      schema.kind === 'descriptors'
        ? registryFromDescriptors(schema.descriptors)
        : registryFromProtoText(schema.text);
    return resolveMethod(registry, service, method).method.input;
  } catch {
    return undefined; // a schema that doesn't build/resolve just loses json_name precision
  }
}
