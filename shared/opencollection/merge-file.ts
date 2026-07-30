import * as yaml from 'js-yaml';
import {
  assertBoundedDocument,
  folderSchema,
  graphqlRequestSchema,
  grpcRequestSchema,
  httpRequestSchema,
  openCollectionSchema,
  websocketRequestSchema,
} from './schemas';

export type OpenCollectionMergeFileKind = 'root' | 'folder' | 'request';

const REQUEST_SCHEMAS = [
  httpRequestSchema,
  grpcRequestSchema,
  graphqlRequestSchema,
  websocketRequestSchema,
] as const;

export function detectOpenCollectionMergeFile(
  relativePath: string,
  candidates: readonly string[]
): OpenCollectionMergeFileKind | null {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized === 'opencollection.yml' || normalized === 'opencollection.yaml') return 'root';
  const basename = normalized.split('/').at(-1);
  if (basename === '_folder.yml' || basename === '_folder.yaml') return 'folder';
  if (!normalized.endsWith('.yml') && !normalized.endsWith('.yaml')) return null;
  return candidates.some((candidate) => isValidRequest(candidate)) ? 'request' : null;
}

export function parseOpenCollectionMergeFile(
  relativePath: string,
  raw: string,
  kind: OpenCollectionMergeFileKind
): unknown {
  let document: unknown;
  try {
    document = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(`Invalid YAML in ${relativePath}: ${(error as Error).message}`);
  }
  assertBoundedDocument(document);

  const valid =
    kind === 'root'
      ? openCollectionSchema.safeParse(document).success
      : kind === 'folder'
        ? folderSchema.safeParse(document).success
        : REQUEST_SCHEMAS.some((schema) => schema.safeParse(document).success);
  if (!valid) {
    const label =
      kind === 'root'
        ? 'OpenCollection root'
        : kind === 'folder'
          ? 'OpenCollection folder'
          : 'OpenCollection request';
    throw new Error(`Invalid ${label} in ${relativePath}`);
  }
  // Validation schemas intentionally strip unknown keys. Return the original
  // JSON-safe document so extensions owned by other tools remain round-trip safe.
  return document;
}

export function serializeOpenCollectionMergeFile(document: unknown): string {
  return yaml.dump(document, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quoteStyle: 'double',
    forceQuotes: true,
  });
}

function isValidRequest(raw: string): boolean {
  try {
    const document = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    assertBoundedDocument(document);
    return REQUEST_SCHEMAS.some((schema) => schema.safeParse(document).success);
  } catch {
    return false;
  }
}
