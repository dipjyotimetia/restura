import * as yaml from 'js-yaml';
import { arr, isObj, type Raw } from './common';
import { UNSAFE_OBJECT_KEYS } from './redaction';
import type { PostmanV3FileMap } from './v3-container';

/**
 * Postman v3 logical tree → the multi-file YAML folder `postman collection
 * migrate` writes (#1201), the exact layout `v3-container.ts` reads:
 *
 *   .resources/definition.yaml           root (`$kind`, `name`, variables, auth, scripts)
 *   <Folder>/.resources/definition.yaml  folder metadata + `order`
 *   <Folder>/<Name>.request.yaml         one request (+ `order`)
 *   <Folder>/.resources/<Name>.resources/examples/<Ex>.example.yaml
 *
 * Names become filename-safe and case-insensitively unique per folder; when
 * that changes a name, the real one is written as `name:` (the reader prefers
 * it over the file name). `order` is an evenly spaced fractional index
 * (1000, 2000, …) shared by folders and requests. Paths use forward slashes
 * and are relative (no wrapper directory). Output is deterministic.
 */

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export const MAX_NAME_LENGTH = 80;
/**
 * Filesystems cap a path segment at 255 bytes (UTF-8 on APFS / ext4), so the
 * name budget leaves room for the longest suffix written after it
 * (`.request.yaml` / `.example.yaml`, 13 bytes; `.resources` is shorter).
 * Collision counters (` (2)`) are carved out of this budget, not added to it.
 */
const MAX_SEGMENT_BYTES = 255;
export const MAX_NAME_BYTES = MAX_SEGMENT_BYTES - '.request.yaml'.length;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** Longest prefix of `s` within `maxBytes` UTF-8 bytes, cut on code-point boundaries. */
function truncateBytes(s: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** A filename-safe form of `name` (no separators, no `..`, no reserved names, bounded). */
export function safeFileName(name: string, maxBytes: number = MAX_NAME_BYTES): string {
  let s = name.replace(ILLEGAL, '_').trim();
  s = s.replace(/^\.+/, (m) => '_'.repeat(m.length));
  // `_` prefix for a reserved name below costs one byte.
  s = truncateBytes(Array.from(s).slice(0, MAX_NAME_LENGTH).join(''), maxBytes - 1);
  s = s.replace(/[. ]+$/, '');
  if (s === '') s = 'Untitled';
  if (RESERVED.test(s.replace(/\..*$/, ''))) s = `_${s}`;
  return s;
}

/** Case-insensitive unique names within one folder. */
class NameSet {
  private readonly used = new Set<string>();

  claim(name: string): string {
    let candidate = safeFileName(name);
    for (let n = 2; this.used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      candidate = `${safeFileName(name, MAX_NAME_BYTES - suffix.length)}${suffix}`;
    }
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

export const ORDER_STEP = 1000;

function dump(doc: Raw): string {
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false });
}

/** `[{ key, value }]` → `{ key: value }` when that loses nothing (the migrate CLI's shorthand). */
function rowsToMap(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const keys = new Set<string>();
  for (const r of rows) {
    if (!isObj(r) || Object.keys(r).some((k) => k !== 'key' && k !== 'value')) return rows;
    if (typeof r.key !== 'string' || typeof r.value !== 'string' || keys.has(r.key)) return rows;
    if (UNSAFE_OBJECT_KEYS.has(r.key)) return rows;
    keys.add(r.key);
  }
  return Object.fromEntries(rows.map((r) => [(r as Raw).key, (r as Raw).value]));
}

function credentialsToMap(auth: unknown): unknown {
  const one = (set: unknown) => {
    if (!isObj(set) || !Array.isArray(set.credentials)) return set;
    const keys = set.credentials.map((c) => (isObj(c) ? c.key : undefined));
    const unique =
      keys.every((k) => typeof k === 'string' && !UNSAFE_OBJECT_KEYS.has(k)) &&
      new Set(keys).size === keys.length;
    if (!unique) return set;
    return {
      ...set,
      credentials: Object.fromEntries(
        set.credentials.map((c) => [(c as Raw).key, (c as Raw).value])
      ),
    };
  };
  return Array.isArray(auth) ? auth.map(one) : one(auth);
}

/** On-disk document: `$kind` first, `name` only when the file name differs, `order` last. */
function diskDoc(node: Raw, fileName: string | undefined, order: number | undefined): Raw {
  const { $kind, name, items: _items, examples: _examples, ...rest } = node;
  const out: Raw = { $kind };
  if (typeof name === 'string' && name !== fileName) out.name = name;
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'auth') out.auth = credentialsToMap(v);
    else if (k === 'queryParams' || k === 'pathVariables') out[k] = rowsToMap(v);
    else out[k] = v;
  }
  if (order !== undefined) out.order = order;
  return out;
}

export function writePostmanV3Files(tree: Raw): PostmanV3FileMap {
  const files: PostmanV3FileMap = {};
  const root = diskDoc(tree, undefined, undefined);
  root.name = tree.name;
  // Keep `$kind`, `name` first in the root definition.
  const { $kind, name, ...rest } = root;
  files['.resources/definition.yaml'] = dump({ $kind, name, ...rest });

  const walk = (items: unknown[], dir: string) => {
    const dirs = new NameSet();
    const requests = new NameSet();
    items.forEach((item, i) => {
      if (!isObj(item)) return;
      const order = (i + 1) * ORDER_STEP;
      const itemName = typeof item.name === 'string' ? item.name : '';
      if (item.$kind === 'collection') {
        const dirName = dirs.claim(itemName);
        const path = `${dir}${dirName}/`;
        files[`${path}.resources/definition.yaml`] = dump(diskDoc(item, dirName, order));
        walk(arr(item.items), path);
        return;
      }
      const base = requests.claim(itemName);
      const doc = diskDoc(item, base, order);
      const examples = arr(item.examples).filter(isObj);
      if (examples.length > 0) {
        const exDir = `.resources/${base}.resources/examples`;
        doc.examples = `./${exDir}`;
        delete doc.order;
        doc.order = order;
        const exNames = new NameSet();
        examples.forEach((ex, j) => {
          const exBase = exNames.claim(typeof ex.name === 'string' ? ex.name : '');
          files[`${dir}${exDir}/${exBase}.example.yaml`] = dump(
            diskDoc(ex, exBase, (j + 1) * ORDER_STEP)
          );
        });
      }
      files[`${dir}${base}.request.yaml`] = dump(doc);
    });
  };
  walk(arr(tree.items), '');
  return files;
}
