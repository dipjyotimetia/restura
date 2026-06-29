import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as yaml from 'js-yaml';
import { isRecord, ROOT_FILENAMES, isRootFilename } from '../util/oc';
import { classifyOcFile, type OcRequestType } from './collectionDetector';

/**
 * A runnable request discovered on disk. `folderPath` uses folder *display
 * names* (from `_folder.yaml` `info.name`, falling back to the directory
 * basename) so it matches the CLI's `LoadedRequest.folderPath` exactly — that
 * parity is what lets run results map back onto the right tree item.
 */
export interface ScannedRequest {
  filePath: string;
  folderPath: string[];
  name: string;
  type: OcRequestType;
  /** `info.seq` when present, for stable ordering (mirrors fs-reader). */
  seq: number;
}

const FOLDER_META = '_folder.yaml';

// WebSocket requests are not runnable by the CLI runner (ocToInternal surfaces
// them as folders), so they're excluded from the test tree. http/grpc/graphql
// are runnable — GraphQL executes as an HTTP request.
const RUNNABLE_TYPES = new Set<OcRequestType>(['http', 'grpc', 'graphql']);

async function folderDisplayName(dir: string): Promise<string> {
  try {
    const raw = await readFile(join(dir, FOLDER_META), 'utf8');
    const meta = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (isRecord(meta) && isRecord(meta.info) && typeof meta.info.name === 'string') {
      return meta.info.name;
    }
  } catch {
    // _folder.yaml optional → fall back to basename
  }
  return basename(dir);
}

/**
 * Walk an OpenCollection directory and return its runnable requests. Mirrors
 * `src/lib/opencollection/fs-reader.ts` skip/sort rules so the discovered set
 * and ordering match what the CLI loads. Returns `[]` if the directory has no
 * `opencollection.{yml,yaml}` root.
 */
export async function scanCollection(rootDir: string): Promise<ScannedRequest[]> {
  const hasRoot = await Promise.all(
    ROOT_FILENAMES.map((f) =>
      stat(join(rootDir, f))
        .then(() => true)
        .catch(() => false)
    )
  );
  if (!hasRoot.some(Boolean)) return [];

  const out: ScannedRequest[] = [];
  await walk(rootDir, [], out);
  return out;
}

async function walk(dir: string, folderPath: string[], out: ScannedRequest[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const collected: ScannedRequest[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const name = await folderDisplayName(full);
      await walk(full, [...folderPath, name], out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isRootFilename(entry.name) || entry.name === FOLDER_META) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    let raw: string;
    try {
      raw = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    const classified = classifyOcFile(full, raw);
    if (classified.kind !== 'request' || !RUNNABLE_TYPES.has(classified.type)) continue;

    collected.push({
      filePath: full,
      folderPath,
      name: classified.name,
      type: classified.type,
      seq: classified.seq,
    });
  }

  // Sort by seq then filename — matches fs-reader's deterministic ordering.
  collected.sort((a, b) =>
    a.seq !== b.seq ? a.seq - b.seq : a.filePath.localeCompare(b.filePath)
  );
  out.push(...collected);
}
