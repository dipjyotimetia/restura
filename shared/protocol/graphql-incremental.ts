/**
 * GraphQL incremental delivery (`@defer` / `@stream`) result merging.
 *
 * Servers stream an initial payload followed by subsequent payloads, usually
 * as `multipart/mixed` parts (see `multipart-mixed-parser.ts`). This module
 * folds those payloads into one ordinary `{ data, errors?, extensions? }`
 * result, so the response viewer, error extraction and test scripts see the
 * same shape a non-incremental server would have returned.
 *
 * Three wire generations are understood:
 *  1. deferSpec=20220824 (Apollo, graphql-yoga / graphql-js 17.0.0-alpha.2):
 *       `{ incremental: [{ data, path, label? } | { items, path }], hasNext }`
 *     where a `@stream` item path ends with the list index of the first item.
 *  2. The newer incremental format (graphql-js >=17.0.0-alpha.3):
 *       initial `{ data, pending: [{ id, path, label? }], hasNext }`, then
 *       `{ incremental: [{ id, data, subPath? } | { id, items }],
 *          completed: [{ id, errors? }], pending?, hasNext }`
 *     where `items` append to the list at the pending path.
 *  3. The pre-2022 draft: a top-level `{ data, path, hasNext }` patch.
 *
 * Backend-agnostic and pure (no DOM / Node APIs). Path segments that could
 * reach `Object.prototype` are ignored — payloads are untrusted upstream data.
 */
import {
  isMultipartMixed,
  parseMultipartBoundary,
  parseMultipartMixed,
} from './multipart-mixed-parser';

type Json = unknown;
type PathSegment = string | number;
type JsonObject = Record<string, Json>;

export interface GraphQLIncrementalResult {
  data?: Json;
  errors?: Json[];
  extensions?: JsonObject;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Nesting depth past which merging stops recursing and the incoming value
 * simply replaces the existing one — a hostile 200k-deep payload must not
 * overflow the stack. Real GraphQL results are nowhere near this deep.
 */
export const MAX_MERGE_DEPTH = 256;

/**
 * Whether `key` may address a slot in `container`. Arrays take only integer
 * indexes up to their length (overwrite or append — never a hole, so a path
 * like `["list", 6000000]` cannot allocate a sparse array that serialises to
 * megabytes of `null`); objects take only string keys that cannot reach
 * `Object.prototype`.
 */
function slotAllowed(container: JsonObject | Json[], key: PathSegment): boolean {
  if (Array.isArray(container)) {
    return Number.isInteger(key) && (key as number) >= 0 && (key as number) <= container.length;
  }
  return typeof key === 'string' && !UNSAFE_KEYS.has(key);
}

function pushAll(target: Json[], items: readonly Json[]): void {
  // A loop, not push(...items): spread hits the engine's argument limit.
  for (const item of items) target.push(item);
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPath(value: Json): value is PathSegment[] {
  return Array.isArray(value) && value.every((s) => typeof s === 'string' || typeof s === 'number');
}

function deepMerge(target: Json, source: Json, depth = 0): Json {
  if (depth >= MAX_MERGE_DEPTH) return source;
  if (Array.isArray(target) && Array.isArray(source)) {
    const out = target.slice();
    source.forEach((item, i) => {
      out[i] = i < out.length ? deepMerge(out[i], item, depth + 1) : item;
    });
    return out;
  }
  if (isObject(target) && isObject(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (UNSAFE_KEYS.has(key)) continue;
      target[key] = Object.hasOwn(target, key) ? deepMerge(target[key], value, depth + 1) : value;
    }
    return target;
  }
  return source;
}

export class GraphQLIncrementalMerger {
  private data: Json = undefined;
  private hasData = false;
  private errors: Json[] = [];
  private extensions: JsonObject | undefined;
  private pending = new Map<string, PathSegment[]>();
  private next = true;
  private count = 0;

  /** Number of non-empty payloads applied so far. */
  get payloadCount(): number {
    return this.count;
  }

  /** Whether the server has signalled more payloads (`hasNext`). */
  get hasNext(): boolean {
    return this.next;
  }

  /** Apply one payload (an initial or subsequent result). */
  apply(payload: Json): void {
    if (!isObject(payload) || Object.keys(payload).length === 0) return; // heartbeat `{}`
    this.count++;

    if (Array.isArray(payload.pending)) this.registerPending(payload.pending);

    if ('data' in payload) {
      if (isPath(payload.path) && this.hasData) {
        // Pre-2022 draft: a top-level patch addressed by `path`.
        this.mergeAt(payload.path, payload.data);
      } else if (!this.hasData) {
        this.data = payload.data;
        this.hasData = true;
      } else {
        this.data = deepMerge(this.data, payload.data);
      }
    }

    if (Array.isArray(payload.incremental)) {
      for (const item of payload.incremental) this.applyIncremental(item);
    }

    if (Array.isArray(payload.completed)) {
      for (const done of payload.completed) {
        if (!isObject(done)) continue;
        if (Array.isArray(done.errors)) pushAll(this.errors, done.errors);
        if (typeof done.id === 'string') this.pending.delete(done.id);
      }
    }

    if (Array.isArray(payload.errors)) pushAll(this.errors, payload.errors);
    if (isObject(payload.extensions)) this.mergeExtensions(payload.extensions);
    if (typeof payload.hasNext === 'boolean') this.next = payload.hasNext;
  }

  /** The merged result so far, in the ordinary GraphQL response shape. */
  get result(): GraphQLIncrementalResult {
    return {
      ...(this.hasData ? { data: this.data } : {}),
      ...(this.errors.length > 0 ? { errors: this.errors.slice() } : {}),
      ...(this.extensions ? { extensions: { ...this.extensions } } : {}),
    };
  }

  private registerPending(entries: Json[]): void {
    for (const entry of entries) {
      if (isObject(entry) && typeof entry.id === 'string' && isPath(entry.path)) {
        this.pending.set(entry.id, entry.path);
      }
    }
  }

  private applyIncremental(item: Json): void {
    if (!isObject(item)) return;
    let path: PathSegment[] | undefined;
    const byId = typeof item.id === 'string' ? this.pending.get(item.id) : undefined;
    if (byId) {
      path = isPath(item.subPath) ? [...byId, ...item.subPath] : byId;
    } else if (isPath(item.path)) {
      path = item.path;
    }

    if (path && Array.isArray(item.items)) {
      if (byId) {
        // Newer format: the path names the list; append.
        const list = this.ensureList(path);
        if (list) pushAll(list, item.items);
      } else {
        // deferSpec=20220824: the path ends with the first item's index.
        // Only overwrite or append (index <= length): no sparse holes.
        const index = path[path.length - 1] as PathSegment;
        const list = this.ensureList(path.slice(0, -1));
        if (list && slotAllowed(list, index)) {
          (item.items as Json[]).forEach((v, i) => {
            list[(index as number) + i] = v;
          });
        }
      }
    } else if (path && 'data' in item) {
      this.mergeAt(path, item.data);
    }

    if (Array.isArray(item.errors)) pushAll(this.errors, item.errors);
    if (isObject(item.extensions)) this.mergeExtensions(item.extensions);
  }

  private mergeExtensions(ext: JsonObject): void {
    this.extensions = deepMerge(this.extensions ?? {}, ext) as JsonObject;
  }

  /** Deep-merge `value` into the node at `path`, creating containers as needed. */
  private mergeAt(path: PathSegment[], value: Json): void {
    if (path.length === 0) {
      this.data = this.hasData ? deepMerge(this.data, value) : value;
      this.hasData = true;
      return;
    }
    const parent = this.walk(path, path.length - 1);
    const key = path[path.length - 1] as PathSegment;
    if (!parent || !slotAllowed(parent, key)) return;
    const container = parent as Record<PathSegment, Json>;
    const existing = container[key];
    container[key] = existing === undefined ? value : deepMerge(existing, value, path.length);
  }

  private ensureList(path: PathSegment[]): Json[] | null {
    if (path.length === 0) return null;
    const parent = this.walk(path, path.length - 1);
    const key = path[path.length - 1] as PathSegment;
    if (!parent || !slotAllowed(parent, key)) return null;
    const container = parent as Record<PathSegment, Json>;
    if (container[key] === undefined || container[key] === null) container[key] = [];
    const list = container[key];
    return Array.isArray(list) ? list : null;
  }

  /**
   * Walk the first `depth` segments of `path`, creating missing containers
   * along the way — a list when the following segment is an index.
   */
  private walk(path: PathSegment[], depth: number): JsonObject | Json[] | null {
    if (depth >= MAX_MERGE_DEPTH) return null;
    if (!this.hasData || !isObject(this.data)) {
      if (this.hasData && this.data !== null && this.data !== undefined) return null;
      this.data = {};
      this.hasData = true;
    }
    let node: Json = this.data;
    for (let i = 0; i < depth; i++) {
      const seg = path[i] as PathSegment;
      if (!isObject(node) && !Array.isArray(node)) return null;
      if (!slotAllowed(node, seg)) return null;
      const container = node as Record<PathSegment, Json>;
      let child = container[seg];
      if (child === undefined || child === null) {
        const fresh: JsonObject | Json[] = typeof path[i + 1] === 'number' ? [] : {};
        // Don't create a container the next segment couldn't address anyway.
        if (i + 1 < path.length && !slotAllowed(fresh, path[i + 1] as PathSegment)) return null;
        child = fresh;
        container[seg] = child;
      }
      node = child;
    }
    return isObject(node) || Array.isArray(node) ? node : null;
  }
}

/** Parse one part body as JSON; undefined when it is not JSON. */
export function parseIncrementalPart(body: string): Json | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Merge a complete, buffered `multipart/mixed` GraphQL response body into one
 * result. Returns null when the content type is not multipart/mixed, it has
 * no boundary, or no part carried a JSON payload — callers then keep the raw
 * body untouched.
 */
export function mergeMultipartGraphQLBody(
  body: string,
  contentType: string | null | undefined
): { result: GraphQLIncrementalResult; parts: number; hasNext: boolean } | null {
  if (!isMultipartMixed(contentType)) return null;
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) return null;
  const merger = new GraphQLIncrementalMerger();
  for (const part of parseMultipartMixed(body, boundary)) {
    const payload = parseIncrementalPart(part.body);
    if (payload !== undefined) merger.apply(payload);
  }
  if (merger.payloadCount === 0) return null;
  return { result: merger.result, parts: merger.payloadCount, hasNext: merger.hasNext };
}
