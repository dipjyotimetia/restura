import * as yaml from 'js-yaml';
import { isObj, MAX_POSTMAN_NESTING_DEPTH } from './common';
import { UNSAFE_OBJECT_KEYS } from './redaction';

/**
 * Postman Collection v3 container reader (#1200).
 *
 * v3 on disk is a multi-file YAML folder (as written by `postman collection
 * migrate`, see `__fixtures__/v3/`):
 *
 *   .resources/definition.yaml           root collection (name, variables, auth, scripts)
 *   <Folder>/.resources/definition.yaml  folder metadata (+ `order`)
 *   <Folder>/<Name>.request.yaml         one request; name = file name
 *   <Folder>/.resources/<Name>.resources/examples/<Ex>.example.yaml
 *
 * Ordering is a fractional index (`order`) shared by folders and requests.
 * The files use a few compact shorthands the JSON schema does not allow
 * (`headers` / `queryParams` / `credentials` as plain maps, `examples` as a
 * relative directory path, `order`); this reader expands them so the result
 * is the schema's logical tree (`$kind: "collection"` root).
 *
 * Input is untrusted. YAML is parsed with js-yaml's default safe schema (no
 * custom types); file count, sizes, nesting depth and node count are capped;
 * paths that are absolute or contain `..` are rejected.
 */

export interface PostmanV3Limits {
  maxFiles: number;
  /** Sum of all file sizes (UTF-8 bytes). */
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Folder nesting (directories, or `items` levels in a single object). */
  maxDepth: number;
  /** Total value nodes visited (YAML aliases are counted per use). */
  maxNodes: number;
  /** Size of a zip archive itself (compressed bytes), checked before inflating. */
  maxArchiveBytes: number;
}

export const POSTMAN_V3_LIMITS: PostmanV3Limits = {
  maxFiles: 5_000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxDepth: MAX_POSTMAN_NESTING_DEPTH,
  maxNodes: 1_000_000,
  maxArchiveBytes: 50 * 1024 * 1024,
};

export class PostmanV3ContainerError extends Error {
  constructor(message: string) {
    super(`Invalid Postman v3 collection: ${message}`);
    this.name = 'PostmanV3ContainerError';
  }
}

export interface ReadV3Options {
  limits?: Partial<PostmanV3Limits>;
  /**
   * The file map comes from a picked folder (`webkitdirectory` / a CLI
   * directory argument): its single top-level directory IS the collection
   * root and is always stripped. Otherwise (zip) a wrapper is stripped only
   * when it provably is the root (see `stripWrapper`).
   */
  pickedRoot?: boolean;
}

export interface PostmanV3Container {
  /** The v3 logical tree (`$kind: "collection"` root). */
  tree: Record<string, unknown>;
  /** Non-YAML files found under a `.resources/` folder that were not read. */
  unread: string[];
}

type Raw = Record<string, unknown>;
export type PostmanV3FileMap = Record<string, string>;

const REQUEST_FILE = /\.request\.ya?ml$/i;
const EXAMPLE_FILE = /\.example\.ya?ml$/i;
const DEFINITION_FILE = /^definition\.ya?ml$/i;

export function resolveLimits(limits?: Partial<PostmanV3Limits>): PostmanV3Limits {
  return { ...POSTMAN_V3_LIMITS, ...limits };
}

/**
 * Normalise one archive / folder entry path to `a/b/c`. Throws on absolute
 * paths, drive letters, `..` segments and NUL bytes; returns `null` for
 * entries to skip (directories, macOS metadata).
 */
export function normaliseEntryPath(path: string): string | null {
  if (path.includes('\0')) throw new PostmanV3ContainerError(`illegal path "${safe(path)}"`);
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new PostmanV3ContainerError(`absolute path "${safe(path)}" is not allowed`);
  }
  const segments = slashed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new PostmanV3ContainerError(`path "${safe(path)}" escapes the collection folder`);
  }
  if (segments.length === 0 || slashed.endsWith('/')) return null;
  if (segments[0] === '__MACOSX' || segments[segments.length - 1] === '.DS_Store') return null;
  return segments.join('/');
}

function safe(path: string): string {
  return path.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** True when `paths` look like a v3 multi-file collection. */
export function isPostmanV3Paths(paths: readonly string[]): boolean {
  return paths.some((p) => {
    const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
    return (
      REQUEST_FILE.test(base) ||
      /(^|\/)\.resources\/definition\.ya?ml$/i.test(p.replace(/\\/g, '/'))
    );
  });
}

/** True when `data` is a `{ relativePath: contents }` map of a v3 folder. */
export function isPostmanV3FileMap(data: unknown): data is PostmanV3FileMap {
  if (!isObj(data)) return false;
  const entries = Object.entries(data);
  return (
    entries.length > 0 &&
    entries.every(([, v]) => typeof v === 'string') &&
    isPostmanV3Paths(entries.map(([k]) => k))
  );
}

// ── node budget / depth guard ────────────────────────────────────────────────

function guardTree(value: unknown, limits: PostmanV3Limits, what: string): void {
  let nodes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > limits.maxNodes) {
      throw new PostmanV3ContainerError(`${what} is too large (too many values)`);
    }
    // Value nesting: generous (items + body + key-value rows) but bounded.
    if (depth > limits.maxDepth * 4) {
      throw new PostmanV3ContainerError(`${what} is nested too deeply`);
    }
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
}

function itemDepth(node: unknown, depth: number, limits: PostmanV3Limits): void {
  if (depth > limits.maxDepth) {
    throw new PostmanV3ContainerError(`folders are nested more than ${limits.maxDepth} levels`);
  }
  if (!isObj(node) || !Array.isArray(node.items)) return;
  for (const child of node.items) itemDepth(child, depth + 1, limits);
}

function parseYaml(text: string, path: string, limits: PostmanV3Limits): unknown {
  let data: unknown;
  try {
    // Default schema = safe: no !!js/* or other custom tags.
    data = yaml.load(text, { filename: path });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'parse error';
    throw new PostmanV3ContainerError(`"${safe(path)}" is not valid YAML (${reason})`);
  }
  guardTree(data, limits, `"${safe(path)}"`);
  return dropUnsafeKeys(data, 0);
}

/**
 * Deep copy without `__proto__` / `constructor` / `prototype` keys. js-yaml
 * (and JSON.parse) create them as OWN properties; copying one with `out[k] =`
 * would set the copy's prototype and smuggle hidden fields onto a node.
 */
function dropUnsafeKeys(value: unknown, depth: number): unknown {
  if (depth > POSTMAN_V3_LIMITS.maxDepth * 4) return null;
  if (Array.isArray(value)) return value.map((v) => dropUnsafeKeys(v, depth + 1));
  if (!isObj(value)) return value;
  const out: Raw = {};
  for (const [k, v] of Object.entries(value)) {
    if (!UNSAFE_OBJECT_KEYS.has(k)) out[k] = dropUnsafeKeys(v, depth + 1);
  }
  return out;
}

// ── shorthand expansion ──────────────────────────────────────────────────────

const KV_KEYS = new Set(['headers', 'queryParams', 'pathVariables', 'metadata']);

function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

/** `{ a: '1' }` → `[{ key: 'a', value: '1' }]` (the schema's row form). */
function mapToRows(v: unknown): unknown {
  if (!isObj(v)) return v;
  return Object.entries(v)
    .filter(([key]) => !UNSAFE_OBJECT_KEYS.has(key))
    .map(([key, value]) => ({ key, value: scalar(value) }));
}

function normaliseAuth(auth: unknown): unknown {
  const one = (set: unknown) => {
    if (!isObj(set) || !isObj(set.credentials)) return set;
    return {
      ...set,
      credentials: Object.entries(set.credentials).map(([key, value]) => ({ key, value })),
    };
  };
  return Array.isArray(auth) ? auth.map(one) : one(auth);
}

/** Expand on-disk shorthands in place-free fashion; drops `order`. */
function expandNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expandNode);
  if (!isObj(node)) return node;
  const out: Raw = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'order' || UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (KV_KEYS.has(key)) out[key] = expandNode(mapToRows(value));
    else if (key === 'auth') out[key] = normaliseAuth(value);
    else out[key] = expandNode(value);
  }
  return out;
}

type OrderKey = number | string | undefined;

function orderOf(node: unknown): OrderKey {
  if (!isObj(node)) return undefined;
  const o = node.order;
  return typeof o === 'number' && Number.isFinite(o) ? o : typeof o === 'string' ? o : undefined;
}

/** Fractional index: numbers numerically, then strings lexicographically, then unordered. */
function compareOrder(a: OrderKey, b: OrderKey): number {
  const rank = (o: OrderKey) => (typeof o === 'number' ? 0 : typeof o === 'string' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function sortItems(items: unknown[]): unknown[] {
  return items
    .map((item, index) => ({ item, index, order: orderOf(item) }))
    .sort((x, y) => compareOrder(x.order, y.order) || x.index - y.index)
    .map((x) => x.item);
}

/** Apply ordering + shorthand expansion to a single-object logical tree. */
function normaliseLogical(node: unknown): unknown {
  if (!isObj(node)) return node;
  const items = Array.isArray(node.items) ? sortItems(node.items).map(normaliseLogical) : undefined;
  const expanded = expandNode({ ...node, items: undefined }) as Raw;
  delete expanded.items;
  return items ? { ...expanded, items } : expanded;
}

// ── folder layout ────────────────────────────────────────────────────────────

interface DirNode {
  name: string;
  definition?: Raw;
  dirs: Map<string, DirNode>;
  requests: Array<{ name: string; path: string; data: Raw }>;
}

function newDir(name: string): DirNode {
  return { name, dirs: new Map(), requests: [] };
}

function dirAt(root: DirNode, segments: string[]): DirNode {
  let node = root;
  for (const seg of segments) {
    let next = node.dirs.get(seg);
    if (!next) {
      next = newDir(seg);
      node.dirs.set(seg, next);
    }
    node = next;
  }
  return node;
}

/**
 * A folder picker or a zip usually wraps everything in one top-level
 * directory. Strip it only when it provably is the collection root: the
 * caller says so (`pickedRoot`), or there is no root definition and the
 * wrapper's own definition names the collection (folder definitions written
 * by Postman carry no `name`; the root one does). Otherwise a collection whose
 * only top-level entry is a folder would lose that folder.
 */
function stripWrapper(
  entries: ReadonlyArray<readonly [string, string]>,
  pickedRoot: boolean,
  limits: PostmanV3Limits
): { prefix: string; rootName?: string } {
  const paths = entries.map(([p]) => p);
  const first = paths[0]?.split('/')[0];
  if (!first || first === '.resources' || !paths.every((p) => p.startsWith(`${first}/`))) {
    return { prefix: '' };
  }
  const wrap = { prefix: `${first}/`, rootName: first };
  if (pickedRoot) return wrap;
  const def = entries.find(([p]) => DEFINITION_AT.test(p.slice(first.length + 1)));
  if (!def) return { prefix: '' };
  const parsed = parseYaml(def[1], def[0], limits);
  return isObj(parsed) && typeof parsed.name === 'string' && parsed.name !== ''
    ? wrap
    : { prefix: '' };
}

const DEFINITION_AT = /^(\.resources\/)?definition\.ya?ml$/i;

function buildFromFiles(
  files: PostmanV3FileMap,
  limits: PostmanV3Limits,
  pickedRoot: boolean,
  unread: string[]
): Raw {
  const entries: Array<[string, string]> = [];
  let total = 0;
  for (const [rawPath, text] of Object.entries(files)) {
    const path = normaliseEntryPath(rawPath);
    if (path === null) continue;
    if (entries.length + 1 > limits.maxFiles) {
      throw new PostmanV3ContainerError(`too many files (limit ${limits.maxFiles})`);
    }
    const bytes = utf8Length(text);
    if (bytes > limits.maxFileBytes) {
      throw new PostmanV3ContainerError(`"${safe(path)}" is too large`);
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      throw new PostmanV3ContainerError('collection is too large');
    }
    entries.push([path, text]);
  }
  const relevant = entries.filter(([p]) => /\.ya?ml$/i.test(p));
  // Externalised scripts / binaries under `.resources/` are never read (only
  // inline scripts are imported): report them so nothing is silently skipped.
  for (const [p] of entries) {
    if (!/\.ya?ml$/i.test(p) && p.split('/').includes('.resources')) unread.push(p);
  }
  if (!isPostmanV3Paths(relevant.map(([p]) => p))) {
    throw new PostmanV3ContainerError('no *.request.yaml or .resources/definition.yaml found');
  }

  const { prefix, rootName } = stripWrapper(relevant, pickedRoot, limits);
  const byPath = new Map<string, string>();
  for (const [p, text] of relevant) byPath.set(p.slice(prefix.length), text);

  const root = newDir(rootName ?? '');
  for (const [path, text] of byPath) {
    const segments = path.split('/');
    const base = segments.pop() as string;
    if (segments.length > limits.maxDepth) {
      throw new PostmanV3ContainerError(`folders are nested more than ${limits.maxDepth} levels`);
    }
    const resIdx = segments.indexOf('.resources');
    if (resIdx !== -1) {
      // `<dir>/.resources/definition.yaml` is folder metadata; anything deeper
      // (examples, scripts) is loaded on demand by the request that links it.
      if (resIdx === segments.length - 1 && DEFINITION_FILE.test(base)) {
        dirAt(root, segments.slice(0, resIdx)).definition = asObj(parseYaml(text, path, limits));
      }
      continue;
    }
    if (DEFINITION_FILE.test(base)) {
      const dir = dirAt(root, segments);
      dir.definition ??= asObj(parseYaml(text, path, limits));
      continue;
    }
    if (REQUEST_FILE.test(base)) {
      const data = asObj(parseYaml(text, path, limits));
      dirAt(root, segments).requests.push({
        name: base.replace(REQUEST_FILE, ''),
        path,
        data,
      });
    }
  }

  const examplesFor = (requestPath: string, ref: unknown): unknown[] | undefined => {
    if (typeof ref !== 'string') return Array.isArray(ref) ? ref : undefined;
    const dir = requestPath.split('/').slice(0, -1);
    for (const seg of ref.replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (dir.length === 0) {
          throw new PostmanV3ContainerError(`examples of "${safe(requestPath)}" escape the folder`);
        }
        dir.pop();
      } else dir.push(seg);
    }
    const prefixDir = dir.length > 0 ? `${dir.join('/')}/` : '';
    const out: unknown[] = [];
    for (const [p, text] of byPath) {
      if (!p.startsWith(prefixDir)) continue;
      const rest = p.slice(prefixDir.length);
      if (rest.includes('/') || !EXAMPLE_FILE.test(rest)) continue;
      const ex = asObj(parseYaml(text, p, limits));
      out.push({ name: rest.replace(EXAMPLE_FILE, ''), ...ex });
    }
    return sortItems(out);
  };

  const toItems = (dir: DirNode): unknown[] => {
    const items: unknown[] = [];
    for (const sub of dir.dirs.values()) {
      const def = sub.definition ?? {};
      items.push({
        ...def,
        $kind: 'collection',
        name: typeof def.name === 'string' && def.name ? def.name : sub.name,
        items: toItems(sub),
      });
    }
    for (const req of dir.requests) {
      const examples = examplesFor(req.path, req.data.examples);
      const item: Raw = {
        ...req.data,
        name: typeof req.data.name === 'string' && req.data.name ? req.data.name : req.name,
      };
      if (examples) item.examples = examples;
      else delete item.examples;
      items.push(item);
    }
    return sortItems(items);
  };

  const def = root.definition ?? {};
  const tree: Raw = {
    ...def,
    $kind: 'collection',
    name: typeof def.name === 'string' && def.name ? def.name : rootName || 'Imported Collection',
  };
  const items = toItems(root);
  if (items.length > 0) tree.items = items;
  return tree;
}

function asObj(v: unknown): Raw {
  return isObj(v) ? v : {};
}

function finish(tree: unknown, limits: PostmanV3Limits, unread: string[]): PostmanV3Container {
  const normalised = normaliseLogical(tree) as Raw;
  itemDepth(normalised, 0, limits);
  guardTree(normalised, limits, 'collection');
  return { tree: normalised, unread };
}

/**
 * Read a v3 collection from a folder / unzipped archive (`{ path: text }`)
 * or a single already-parsed JSON/YAML object into the logical tree.
 */
export function readPostmanV3Container(
  input: PostmanV3FileMap | unknown,
  options: ReadV3Options = {}
): PostmanV3Container {
  const limits = resolveLimits(options.limits);
  if (isObj(input) && input.$kind === 'collection') {
    itemDepth(input, 0, limits);
    guardTree(input, limits, 'collection');
    return finish(dropUnsafeKeys(input, 0), limits, []);
  }
  if (isObj(input) && Object.values(input).every((v) => typeof v === 'string')) {
    const unread: string[] = [];
    const tree = buildFromFiles(
      input as PostmanV3FileMap,
      limits,
      options.pickedRoot === true,
      unread
    );
    return finish(tree, limits, unread);
  }
  throw new PostmanV3ContainerError('expected a $kind: collection document or a v3 folder');
}
